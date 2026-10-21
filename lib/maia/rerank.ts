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
// - Opening-book boosting reads a real per-opponent OpeningTree, gated on
//   at least MIN_OCCURRENCES observations for the candidate move.

import { Chess } from "chess.js";
import { loadMoveVocab } from "./moveVocab";
import { mirrorUci } from "./boardToTensor";
import { openingBookPosition, MIN_OCCURRENCES, OPENING_BOOST_CAP } from "../profile/openingTree";
import { evalFen } from "../eval/stockfishEngine";
import type { OpponentFeatures } from "../lichess/opponentFeatures";
import type { OpeningTree, PieceActivityProfile, PieceType } from "@/types";

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

function moverCpFromResult(result: { cp: number | null; mate: number | null }): number {
  if (result.cp !== null) return -result.cp;
  if (result.mate !== null) return result.mate > 0 ? -10000 : 10000;
  return 0;
}

// Arbitrary judgment-call constants, same spirit as Step 4's flag thresholds
// and Step 8's aggression-index weights — not validated against anything,
// flagged for later tuning once Step 10's replay loop makes behavior visible.
const QUEEN_TRADE_BOOST_STRENGTH = 1.5; // multiplier scale on (tradeRate - baseline), now piece/phase-scoped
const TRADE_RATE_BASELINE = 0.5;        // "coin flip" baseline for whether this piece trades off in this phase
const AGGRESSION_BOOST_STRENGTH = 1.5;
const MIN_BOOST_FACTOR = 0.1;           // clamp so boosts can't zero out or invert a move's rank

// Piece-activity preference boost; unlike capture/check boosts, this can
// also favor quiet moves associated with a particular piece type.
const PIECE_BOOST_STRENGTH = 1.5;
const POPULATION_PIECE_SHARE_BASELINE: Record<"opening" | "middlegame" | "endgame", Record<PieceType, number>> = {
  opening: { p: 0.45, n: 0.18, b: 0.13, r: 0.03, q: 0.04, k: 0.17 },
  middlegame: { p: 0.3, n: 0.15, b: 0.13, r: 0.15, q: 0.12, k: 0.15 },
  endgame: { p: 0.25, n: 0.08, b: 0.08, r: 0.2, q: 0.09, k: 0.3 },
};
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

function softmax(logits: Float32Array): Float64Array {
  let maxVal = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (!Number.isFinite(logits[i])) throw new Error(`Maia returned a non-finite logit at index ${i}`);
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
  pieceActivityProfile?: PieceActivityProfile | null;
  openingTree?: OpeningTree | null;
}): Promise<RerankResult> {
  const { fen, logitsMaia, pieceActivityProfile, openingTree } = params;
  void params.opponentFeatures;

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
  const currentPhase = gamePhaseFromFen(chess);
  const openingPosition = openingBookPosition(openingTree, fen);
  let playerPhaseTotalMoves = 0;
  if (pieceActivityProfile) {
    for (const pieceType of ["p", "n", "b", "r", "q", "k"] as const) {
      playerPhaseTotalMoves += pieceActivityProfile.byPieceType[pieceType][currentPhase].moveCount;
    }
  }

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
  let anyOpeningBoostApplied = false;

  for (let i = 0; i < vocab.length; i++) {
    const modelUci = vocab[i];
    const m = legalByUci.get(modelUci);
    if (!m) continue; // illegal move, excluded entirely

    const uci = m.from + m.to + (m.promotion ?? "");

    const baseProbability = probs[i] / legalProbSum;

    const isCapture = !!m.captured;
    const isQueenCapture = m.captured === "q";
    const isCheck = m.san.includes("+") || m.san.includes("#");

    let boost = 1;

    // Trade and aggression signals now come from the opponent's per-piece,
    // per-phase PieceActivityProfile. Low-confidence profiles contribute no
    // boost for this signal.
    const pieceBucketForTrade =
      pieceActivityProfile && pieceActivityProfile.confidence !== "low"
        ? pieceActivityProfile.byPieceType[m.piece as PieceType][currentPhase]
        : null;
    const tradeRate =
      pieceBucketForTrade && pieceBucketForTrade.moveCount > 0
        ? pieceBucketForTrade.tradeInitiatedCount / pieceBucketForTrade.moveCount
        : null;

    if (tradeRate !== null && isQueenCapture) {
      boost *= 1 + (tradeRate - TRADE_RATE_BASELINE) * QUEEN_TRADE_BOOST_STRENGTH;
    }
    if (tradeRate !== null && (isCapture || isCheck)) {
      boost *= 1 + (tradeRate - TRADE_RATE_BASELINE) * AGGRESSION_BOOST_STRENGTH;
    }

    if (pieceActivityProfile && playerPhaseTotalMoves >= 5) {
      const pieceType = m.piece as PieceType;
      const bucket = pieceActivityProfile.byPieceType[pieceType][currentPhase];
      const playerShare = bucket.moveCount / playerPhaseTotalMoves;
      const populationShare = POPULATION_PIECE_SHARE_BASELINE[currentPhase][pieceType];
      boost *= 1 + (playerShare - populationShare) * PIECE_BOOST_STRENGTH;
    }

    let openingMatchCount: number | null = null;
    let openingTotalCount: number | null = null;
    if (openingPosition) {
      const matchCount = openingPosition.byUci[uci] ?? 0;
      if (matchCount >= MIN_OCCURRENCES) {
        const share = matchCount / openingPosition.total;
        boost *= Math.min(OPENING_BOOST_CAP, 1 + share * (OPENING_BOOST_CAP - 1));
        openingMatchCount = matchCount;
        openingTotalCount = openingPosition.total;
        anyOpeningBoostApplied = true;
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
    topCandidate.uci !== baseTopMove.uci &&
    (topCandidate.isCapture || topCandidate.isCheck)
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
      if (boostedMoverCp < baseMoverCp - SAFETY_CP_LOSS_THRESHOLD) {
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
