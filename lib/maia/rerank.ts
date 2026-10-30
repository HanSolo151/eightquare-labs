// lib/maia/rerank.ts
//
// Step 9 — reranking layer. Runs on the MAIN THREAD, not in the worker:
// it needs OpponentFeatures (lives in client/React state) and has no need
// to round-trip through postMessage just to multiply some numbers. The
// worker's job stays "FEN -> raw logits"; this file's job is
// "raw logits + opponent profile -> ranked legal moves".
//
// IMPORTANT, read before changing thresholds:
// - logits_maia is raw, unsoftmaxed model output (see maia.worker.ts). The
//   softmax values below are relative move-selection weights at temperature
//   1, not empirically calibrated probabilities. No Python reference output
//   is included in this repository for cross-checking the temperature.
// - Maia's raw argmax can be illegal (Step 7 flagged, never fixed). This
//   file is now the ONLY place legality is enforced — baseTopMove and
//   topMove below are both guaranteed legal. If you call the worker
//   directly elsewhere, its output is still NOT legality-checked.
// - Opponent-level style rates are weak priors and are shrunk toward neutral.
// - Opening choices use a Maia-prior/empirical-frequency blend. Piece usage
//   shares are intentionally excluded: they do not predict a specific move.

import { Chess } from "chess.js";
import { loadMoveVocab } from "./moveVocab";
import { mirrorUci } from "./boardToTensor";
import { openingBookPosition, MIN_OCCURRENCES, OPENING_BOOST_CAP } from "../profile/openingTree";
import { evalFen } from "../eval/stockfishEngine";
import type { OpponentFeatures } from "../lichess/opponentFeatures";
import type { OpeningTree } from "@/types";

export interface RerankedMove {
  uci: string;
  san: string;
  baseProbability: number;     // Relative Maia selection weight over legal moves; not calibrated
  adjustedProbability: number; // Relative weight after profile boosts; not calibrated
  boostFactor: number;         // adjustedProbability / baseProbability, for debugging/display
  isCapture: boolean;
  isQueenCapture: boolean;
  isCheck: boolean;
  openingMatchCount: number | null;
  openingTotalCount: number | null;
}

export interface RerankResult {
  fen: string;
  baseTopMove: { uci: string; san: string; probability: number } | null; // what Maia alone picks
  topMove: { uci: string; san: string; probability: number } | null;     // after reranking
  moves: RerankedMove[]; // all legal moves, sorted by adjustedProbability desc
  openingBoostApplied: boolean;
  safetyChecked: boolean;
  safetyDowngraded: boolean;
}

const SAFETY_CP_LOSS_THRESHOLD = 150;

function moverCpFromResult(result: { cp: number | null; mate: number | null }): number | null {
  if (result.cp !== null && Number.isFinite(result.cp)) return -result.cp;
  if (result.mate !== null && Number.isFinite(result.mate)) return result.mate > 0 ? -10000 : 10000;
  return null;
}

// Arbitrary judgment-call constants, same spirit as Step 4's flag thresholds
// and Step 8's aggression-index weights — not validated against anything,
// flagged for later tuning once Step 10's replay loop makes behavior visible.
const QUEEN_TRADE_BOOST_STRENGTH = 0.5;
const AGGRESSION_BOOST_STRENGTH = 0.5;
const MIN_BOOST_FACTOR = 0.25;
const PROFILE_PRIOR_GAMES = 20;
const OPENING_PRIOR_STRENGTH = 5;
const ENDGAME_MATERIAL_FRACTION = 0.5;
const FULL_MATERIAL = 78;
const OPENING_END_MOVE = 12;
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function gamePhaseFromFen(chess: Chess): "opening" | "middlegame" | "endgame" {
  let material = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (square) material += PIECE_VALUES[square.type] ?? 0;
    }
  }
  if (material / FULL_MATERIAL <= ENDGAME_MATERIAL_FRACTION) return "endgame";
  const fullmoveNumber = Number.parseInt(chess.fen().split(" ")[5] ?? "1", 10) || 1;
  if (fullmoveNumber <= OPENING_END_MOVE) return "opening";
  return "middlegame";
}

export async function rerankMoves(params: {
  fen: string;
  logitsMaia: Float32Array;
  opponentFeatures: OpponentFeatures;
  openingTree?: OpeningTree | null;
}): Promise<RerankResult> {
  const { fen, logitsMaia, opponentFeatures, openingTree } = params;

  const vocab = await loadMoveVocab(); // throws if not exactly 1880 entries, per moveVocab.ts
  if (logitsMaia.length !== vocab.length) {
    throw new Error(
      `logitsMaia length (${logitsMaia.length}) does not match move vocab length (${vocab.length}) — ` +
        `model/vocab mismatch, do not trust any ranking from this call`
    );
  }

  const chess = new Chess(fen);
  const mirrorMoves = chess.turn() === "b";
  const legalMoves = chess.moves({ verbose: true });
  const openingPosition = openingBookPosition(openingTree, fen);
  // Shrink sparse profiles toward a neutral population prior instead of
  // allowing a handful of games to swing the move distribution sharply.
  const profileReliability = Math.max(0, opponentFeatures.gamesAnalyzed) /
    (Math.max(0, opponentFeatures.gamesAnalyzed) + PROFILE_PRIOR_GAMES);

  if (legalMoves.length === 0) {
    // Game over (checkmate/stalemate) at this FEN — nothing to rerank.
    return {
      fen, baseTopMove: null, topMove: null, moves: [], openingBoostApplied: false,
      safetyChecked: false, safetyDowngraded: false,
    };
  }

  // Map UCI -> verbose move info for every LEGAL move. chess.js verbose
  // moves use king-destination UCI for castling (e.g. e1g1), which matches
  // standard UCI notation and should match the vocab's convention — this
  // assumption is inherited from Step 7's boardToTensor/moveVocab work,
  // not independently re-verified here.
  const legalByUci = new Map<string, (typeof legalMoves)[number]>();
  for (const m of legalMoves) {
    const uci = m.from + m.to + (m.promotion ?? "");
    // logits are indexed from Maia-2's canonical White-to-move perspective.
    // Convert real-board legal moves to that vocabulary orientation.
    legalByUci.set(mirrorMoves ? mirrorUci(uci) : uci, m);
  }

  let maxLegalLogit = -Infinity;
  for (let i = 0; i < vocab.length; i++) {
    if (!Number.isFinite(logitsMaia[i])) throw new Error(`Maia returned a non-finite logit at index ${i}`);
    if (legalByUci.has(vocab[i]) && logitsMaia[i] > maxLegalLogit) maxLegalLogit = logitsMaia[i];
  }
  if (!Number.isFinite(maxLegalLogit)) throw new Error("Maia move vocabulary has no legal move for this position");

  const legalExpByUci = new Map<string, number>();
  let legalExpSum = 0;
  for (let i = 0; i < vocab.length; i++) {
    if (!legalByUci.has(vocab[i])) continue;
    const weight = Math.exp(logitsMaia[i] - maxLegalLogit);
    legalExpByUci.set(vocab[i], weight);
    legalExpSum += weight;
  }
  if (!(legalExpSum > 0) || !Number.isFinite(legalExpSum)) throw new Error("Maia legal-move logits could not be normalized");

  // This is Maia's conditional distribution over legal moves. Illegal logits
  // are excluded before normalization and cannot cause legal weights to
  // underflow to zero.

  const results: RerankedMove[] = [];
  let anyOpeningBoostApplied = false;

  for (let i = 0; i < vocab.length; i++) {
    const modelUci = vocab[i];
    const m = legalByUci.get(modelUci);
    if (!m) continue; // illegal move, excluded entirely

    const uci = m.from + m.to + (m.promotion ?? "");

    const baseProbability = (legalExpByUci.get(modelUci) ?? 0) / legalExpSum;

    const isCapture = !!m.captured;
    const isQueenCapture = m.captured === "q";
    const isCheck = m.san.includes("+") || m.san.includes("#");

    let boost = 1;

    // Opponent-level rates are weak priors, not move-conditioned evidence;
    // shrink and cap them. Piece-usage shares are omitted because global
    // piece frequency does not establish a preference between legal moves.
    if (opponentFeatures.gamesAnalyzed >= 5 && (isCapture || isCheck)) {
      const aggression = Math.max(0, Math.min(1, opponentFeatures.aggressionIndex));
      boost *= 1 + (aggression - 0.35) * AGGRESSION_BOOST_STRENGTH * profileReliability;
    }
    if (opponentFeatures.gamesAnalyzed >= 5 && isQueenCapture) {
      const queenTradeRate = Math.max(0, Math.min(1, opponentFeatures.queenTradeRate));
      boost *= 1 + (queenTradeRate - 0.5) * QUEEN_TRADE_BOOST_STRENGTH * profileReliability;
    }

    let openingMatchCount: number | null = null;
    let openingTotalCount: number | null = null;
    if (openingPosition && openingPosition.total >= MIN_OCCURRENCES) {
      const matchCount = openingPosition.byUci[uci] ?? 0;
      // Empirical-Bayes blend: observed choices contribute counts while
      // Maia's legal-move distribution supplies five prior observations.
      // Every legal candidate is updated, so unobserved alternatives are
      // treated as evidence too rather than left untouched.
      const posteriorProbability = (matchCount + OPENING_PRIOR_STRENGTH * baseProbability) /
        (openingPosition.total + OPENING_PRIOR_STRENGTH);
      boost *= Math.min(OPENING_BOOST_CAP, posteriorProbability / Math.max(baseProbability, 1e-12));
      anyOpeningBoostApplied = true;
      if (matchCount >= MIN_OCCURRENCES) {
        openingMatchCount = matchCount;
        openingTotalCount = openingPosition.total;
      }
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
      openingMatchCount,
      openingTotalCount,
    });
  }

  // Renormalize adjusted probabilities back to sum to 1 over legal moves.
  const adjustedSum = results.reduce((s, r) => s + r.adjustedProbability, 0) || 1e-12;
  for (const r of results) r.adjustedProbability /= adjustedSum;

  results.sort((a, b) => b.adjustedProbability - a.adjustedProbability);

  const baseTopMove = [...results].sort((a, b) => b.baseProbability - a.baseProbability)[0];
  let topCandidate = results[0];
  let safetyChecked = false;
  let safetyDowngraded = false;

  if (
    topCandidate &&
    baseTopMove &&
    topCandidate.uci !== baseTopMove.uci
  ) {
    safetyChecked = true;
    try {
      const afterBoosted = new Chess(fen);
      afterBoosted.move(topCandidate.san);
      const afterBase = new Chess(fen);
      afterBase.move(baseTopMove.san);
      const [boostedEval, baseEval] = await Promise.all([
        evalFen(afterBoosted.fen()),
        evalFen(afterBase.fen()),
      ]);
      const boostedMoverCp = moverCpFromResult(boostedEval);
      const baseMoverCp = moverCpFromResult(baseEval);
      if (boostedMoverCp === null || baseMoverCp === null ||
          boostedMoverCp < baseMoverCp - SAFETY_CP_LOSS_THRESHOLD) {
        safetyDowngraded = true;
        topCandidate = baseTopMove;
      }
    } catch (err) {
      console.error("Phase 4 safety check failed, falling back to baseTopMove:", err);
      safetyDowngraded = true;
      topCandidate = baseTopMove;
    }
  }

  return {
    fen,
    baseTopMove: baseTopMove
      ? { uci: baseTopMove.uci, san: baseTopMove.san, probability: baseTopMove.baseProbability }
      : null,
    topMove: topCandidate
      ? { uci: topCandidate.uci, san: topCandidate.san, probability: topCandidate.adjustedProbability }
      : null,
    moves: results,
    openingBoostApplied: anyOpeningBoostApplied,
    safetyChecked,
    safetyDowngraded,
  };
}
