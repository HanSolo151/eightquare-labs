// lib/maia/rerank.ts
//
// Step 9 — reranking layer. Runs on the MAIN THREAD, not in the worker:
// it needs OpponentFeatures (lives in client/React state) and has no need
// to round-trip through postMessage just to multiply some numbers. The
// worker's job stays "FEN -> raw logits"; this file's job is
// "raw logits + opponent profile -> ranked legal moves".
//
// IMPORTANT, read before changing thresholds:
// - logits_maia is RAW, UNSOFTMAXED output (confirmed from maia.worker.ts
//   and Step 1's validation, which never applied or checked a softmax).
//   This file applies softmax itself. This was never cross-checked against
//   the Python side's own notion of "probabilities" — if Python applies
//   softmax differently (e.g. temperature-scaled), this will diverge
//   slightly. Worth a Python-side sanity check if the rankings ever look
//   off versus the Step 1 validation numbers.
// - Maia's raw argmax can be illegal (Step 7 flagged, never fixed). This
//   file is now the ONLY place legality is enforced — baseTopMove and
//   topMove below are both guaranteed legal. If you call the worker
//   directly elsewhere, its output is still NOT legality-checked.
// - Opening-book boosting is a STUB (openingBoostApplied always false).
//   OpponentFeatures.mostCommonOpenings is whole-game data (name/eco/count),
//   not a move-by-move book tree, so there's no honest way to tell "is this
//   candidate move the book continuation" from what Step 8 collects. Needs
//   a new data source (e.g. Lichess's /api/opening-explorer) before this
//   can be real. Left as a documented no-op rather than faked.

import { Chess } from "chess.js";
import { loadMoveVocab } from "./moveVocab";
import type { OpponentFeatures } from "../lichess/opponentFeatures";

export interface RerankedMove {
  uci: string;
  san: string;
  baseProbability: number;     // Maia alone, softmaxed + renormalized over legal moves only
  adjustedProbability: number; // after opponent-feature boosts, renormalized over legal moves
  boostFactor: number;         // adjustedProbability / baseProbability, for debugging/display
  isCapture: boolean;
  isQueenCapture: boolean;
  isCheck: boolean;
}

export interface RerankResult {
  fen: string;
  baseTopMove: { uci: string; san: string; probability: number } | null; // what Maia alone picks
  topMove: { uci: string; san: string; probability: number } | null;     // after reranking
  moves: RerankedMove[]; // all legal moves, sorted by adjustedProbability desc
  openingBoostApplied: false; // always false — see file header. Kept as an explicit field
                               // so callers/UI can show "opening data not available" honestly
                               // instead of silently pretending it happened.
}

// Arbitrary judgment-call constants, same spirit as Step 4's flag thresholds
// and Step 8's aggression-index weights — not validated against anything,
// flagged for later tuning once Step 10's replay loop makes behavior visible.
const QUEEN_TRADE_BOOST_STRENGTH = 1.5; // multiplier scale on (queenTradeRate - baseline)
const QUEEN_TRADE_BASELINE = 0.5;       // "coin flip" baseline for whether queens come off
const AGGRESSION_BOOST_STRENGTH = 1.5;
const AGGRESSION_BASELINE = 0.35;       // roughly the brino test value from Step 8's live run —
                                         // used as "typical" rather than any principled number
const MIN_BOOST_FACTOR = 0.1;           // clamp so boosts can't zero out or invert a move's rank

function softmax(logits: Float32Array): Float64Array {
  let maxVal = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > maxVal) maxVal = logits[i];
  }
  let sum = 0;
  const out = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - maxVal);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < logits.length; i++) out[i] /= sum;
  return out;
}

export async function rerankMoves(params: {
  fen: string;
  logitsMaia: Float32Array;
  opponentFeatures: OpponentFeatures;
}): Promise<RerankResult> {
  const { fen, logitsMaia, opponentFeatures } = params;

  const vocab = await loadMoveVocab(); // throws if not exactly 1880 entries, per moveVocab.ts
  if (logitsMaia.length !== vocab.length) {
    throw new Error(
      `logitsMaia length (${logitsMaia.length}) does not match move vocab length (${vocab.length}) — ` +
        `model/vocab mismatch, do not trust any ranking from this call`
    );
  }

  const chess = new Chess(fen);
  const legalMoves = chess.moves({ verbose: true });

  if (legalMoves.length === 0) {
    // Game over (checkmate/stalemate) at this FEN — nothing to rerank.
    return { fen, baseTopMove: null, topMove: null, moves: [], openingBoostApplied: false };
  }

  // Map UCI -> verbose move info for every LEGAL move. chess.js verbose
  // moves use king-destination UCI for castling (e.g. e1g1), which matches
  // standard UCI notation and should match the vocab's convention — this
  // assumption is inherited from Step 7's boardToTensor/moveVocab work,
  // not independently re-verified here.
  const legalByUci = new Map<string, (typeof legalMoves)[number]>();
  for (const m of legalMoves) {
    const uci = m.from + m.to + (m.promotion ?? "");
    legalByUci.set(uci, m);
  }

  const probs = softmax(logitsMaia);

  // Sum raw softmax probability mass over legal moves only, so we can
  // renormalize Maia's output to a proper distribution over LEGAL moves —
  // this also throws out (and documents, via baseTopMove's legality guarantee)
  // any probability mass Maia put on illegal moves.
  let legalProbSum = 0;
  for (let i = 0; i < vocab.length; i++) {
    if (legalByUci.has(vocab[i])) legalProbSum += probs[i];
  }
  if (legalProbSum === 0) {
    // Degenerate case: Maia's distribution put ~zero mass on every legal
    // move (shouldn't happen in practice, but don't divide by zero).
    legalProbSum = 1e-12;
  }

  const results: RerankedMove[] = [];

  for (let i = 0; i < vocab.length; i++) {
    const uci = vocab[i];
    const m = legalByUci.get(uci);
    if (!m) continue; // illegal move, excluded entirely

    const baseProbability = probs[i] / legalProbSum;

    const isCapture = !!m.captured;
    const isQueenCapture = m.captured === "q";
    const isCheck = m.san.includes("+") || m.san.includes("#");

    let boost = 1;

    // Queen-trade tendency boost.
    if (isQueenCapture) {
      boost *= 1 + (opponentFeatures.queenTradeRate - QUEEN_TRADE_BASELINE) * QUEEN_TRADE_BOOST_STRENGTH;
    }

    // Aggression boost — applies to any forcing move (capture or check),
    // not just queen captures. Overlaps with the queen-trade boost above
    // for queen-capturing checks; this is intentional (both signals apply),
    // not a bug, but worth knowing if a move's boost looks unexpectedly large.
    if (isCapture || isCheck) {
      boost *= 1 + (opponentFeatures.aggressionIndex - AGGRESSION_BASELINE) * AGGRESSION_BOOST_STRENGTH;
    }

    boost = Math.max(MIN_BOOST_FACTOR, boost);

    results.push({
      uci,
      san: m.san,
      baseProbability,
      adjustedProbability: baseProbability * boost, // renormalized below
      boostFactor: boost,
      isCapture,
      isQueenCapture,
      isCheck,
    });
  }

  // Renormalize adjusted probabilities back to sum to 1 over legal moves.
  const adjustedSum = results.reduce((s, r) => s + r.adjustedProbability, 0) || 1e-12;
  for (const r of results) r.adjustedProbability /= adjustedSum;

  results.sort((a, b) => b.adjustedProbability - a.adjustedProbability);

  const baseTopMove = [...results].sort((a, b) => b.baseProbability - a.baseProbability)[0];

  return {
    fen,
    baseTopMove: baseTopMove
      ? { uci: baseTopMove.uci, san: baseTopMove.san, probability: baseTopMove.baseProbability }
      : null,
    topMove: results[0]
      ? { uci: results[0].uci, san: results[0].san, probability: results[0].adjustedProbability }
      : null,
    moves: results,
    openingBoostApplied: false,
  };
}