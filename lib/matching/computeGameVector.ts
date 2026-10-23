import { Chess, type Square } from "chess.js";
import { extractMoveFeatures } from "@/lib/features/extractFeatures";
import { emptyPieceActivityProfile, updatePieceActivityProfile } from "@/lib/profile/pieceActivityProfile";
import type { EvalPoint, FlaggedMove, GameEval, ParsedGame, PieceType } from "@/types";
import { MATCHING_CONFIG } from "@/config/matching";
import { PHASES, VECTOR_DIMENSIONS, type MatchPhase, type StyleVector, type VectorCalibration } from "./vectorSchema";

const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const KING_ZONE_WEIGHT: Record<PieceType, number> = { p: 0, n: 1, b: 1, r: 2, q: 3, k: 0 };
const CENTRAL_FILES = new Set(["c", "d", "e", "f"]);

type MatchFlag = Pick<FlaggedMove, "ply" | "gamePhase" | "color">;
type PhaseMetrics = Record<MatchPhase, StyleVector | null>;
type PhaseDiagnostics = Record<MatchPhase, {
  kingZoneAttackers: number | null;
  materialAcceptedLosses: number[];
  kingShieldDeltas: number[];
  pawnStructure: { openOrHalfOpenFiles: number; centralPawnTension: number; bucket: number } | null;
  evalDeltaSamples: number[];
}>;

/**
 * Computes raw per-game vectors. Apply corpus calibration with
 * normalizeGameVectors before persistence or matching.
 * Returns null for phases without any eligible own flagged moment.
 */
export function computeGameVector(game: ParsedGame, evaluation: GameEval, flaggedMoves: MatchFlag[]): PhaseMetrics {
  return computeGameVectorDetails(game, evaluation, flaggedMoves).vectors;
}

export function computeGameVectorDetails(
  game: ParsedGame,
  evaluation: GameEval,
  flaggedMoves: MatchFlag[],
): { vectors: PhaseMetrics; diagnostics: PhaseDiagnostics } {
  const chess = new Chess();
  const fenBefore: string[] = [];
  const fenAfter: string[] = [];
  const moveResults: Array<ReturnType<Chess["move"]> | null> = [];
  for (const san of game.moves) {
    fenBefore.push(chess.fen());
    try {
      const move = chess.move(san);
      moveResults.push(move);
      fenAfter.push(chess.fen());
    } catch {
      moveResults.push(null);
      fenAfter.push(fenBefore.at(-1)!);
      break;
    }
  }

  const phaseForPly = (ply: number): MatchPhase => {
    if (ply < MATCHING_CONFIG.PLY_CUTOFFS.openingEnd) return "opening";
    if (ply < MATCHING_CONFIG.PLY_CUTOFFS.middlegameEnd) return "middlegame";
    return "endgame";
  };
  const features = extractMoveFeatures(game).map((feature) => ({ ...feature, gamePhase: phaseForPly(feature.ply) }));
  const adjustedEvaluation: GameEval = {
    ...evaluation,
    points: evaluation.points.map((point) => ({ ...point, ply: point.ply })),
  };
  const pieceProfile = updatePieceActivityProfile(
    emptyPieceActivityProfile("style-vector"),
    game.id,
    game.moves,
    adjustedEvaluation,
    features,
    game.playerColor,
  );

  const flagsByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    flaggedMoves.filter((flag) => flag.color === game.playerColor && phaseForPly(flag.ply) === phase),
  ])) as Record<MatchPhase, MatchFlag[]>;
  const pointsByPly = new Map(evaluation.points.map((point) => [point.ply, point]));
  const vectors = {} as PhaseMetrics;
  const diagnostics = {} as PhaseDiagnostics;

  for (const phase of PHASES) {
    const flags = flagsByPhase[phase];
    const phasePlies = game.moves.map((_, ply) => ply).filter((ply) => phaseForPly(ply) === phase);
    if (flags.length === 0 || phasePlies.length === 0) {
      vectors[phase] = null;
      diagnostics[phase] = {
        kingZoneAttackers: null, materialAcceptedLosses: [], kingShieldDeltas: [],
        pawnStructure: null, evalDeltaSamples: [],
      };
      continue;
    }

    const materialAggression = computeMaterialAggression(flags, game, fenBefore, fenAfter, moveResults);
    const shieldDeltas = flags.map((flag) => {
      const before = new Chess(fenBefore[flag.ply]);
      const after = new Chess(fenAfter[flag.ply]);
      return pawnShieldScore(after, game.playerColor) - pawnShieldScore(before, game.playerColor);
    });
    const kingZoneCounts = flags.map((flag) => kingZoneAttackers(new Chess(fenAfter[flag.ply]), game.playerColor));
    const bucket = pieceProfile.byPieceType;
    const activityDifferential = computePieceActivityDifferential(bucket, phase);
    const midpointPly = phasePlies[Math.floor((phasePlies.length - 1) / 2)];
    const pawnStructure = pawnStructureMetricsAt(new Chess(fenBefore[midpointPly]));
    const evalDeltas = computeEvalDeltas(phasePlies, pointsByPly);
    const evalVolatility = standardDeviation(evalDeltas);

    const raw: StyleVector = {
      materialAggression: mean(materialAggression),
      kingSafetyDelta: mean(shieldDeltas),
      pieceActivityDifferential: activityDifferential,
      pawnStructureBucket: pawnStructure.bucket,
      evalVolatility,
    };
    // Assert the downstream contract in development and keep accidental
    // dimensions from making it into the stored JSON.
    if (Object.keys(raw).length !== VECTOR_DIMENSIONS.length) throw new Error("Style vector dimension mismatch");
    vectors[phase] = raw;
    diagnostics[phase] = {
      kingZoneAttackers: mean(kingZoneCounts),
      materialAcceptedLosses: materialAggression,
      kingShieldDeltas: shieldDeltas,
      pawnStructure,
      evalDeltaSamples: evalDeltas,
    };
  }

  return { vectors, diagnostics };
}

export function normalizeStyleVector(vector: StyleVector, calibration: VectorCalibration[MatchPhase]): StyleVector {
  return Object.fromEntries(VECTOR_DIMENSIONS.map((dimension) => {
    const stdDev = calibration.stdDevs[dimension];
    return [dimension, stdDev > 0 ? (vector[dimension] - calibration.means[dimension]) / stdDev : 0];
  })) as StyleVector;
}

export function normalizeGameVectors(vectors: PhaseMetrics, calibration: VectorCalibration): PhaseMetrics {
  return Object.fromEntries(PHASES.map((phase) => [
    phase,
    vectors[phase] ? normalizeStyleVector(vectors[phase], calibration[phase]) : null,
  ])) as PhaseMetrics;
}

/** Named proxy: sacrificed material is measured after the opponent's reply. */
export function computeMaterialAggression(
  flags: MatchFlag[], game: ParsedGame, fenBefore: string[], fenAfter: string[],
  moveResults: Array<ReturnType<Chess["move"]> | null>,
): number[] {
  const acceptedLosses: number[] = [];
  for (const flag of flags) {
    const replyPly = flag.ply + 1;
    if (replyPly >= game.moves.length || !fenAfter[replyPly]) continue;
    const ownMove = moveResults[flag.ply];
    const priorMove = moveResults[flag.ply - 1];
    // A matching prior opponent capture followed by our equal-value capture
    // is a recapture inside an exchange, not accepted material aggression.
    if (priorMove?.captured && ownMove?.captured && priorMove.captured === ownMove.captured) continue;
    const before = materialBalance(new Chess(fenBefore[flag.ply]), game.playerColor);
    const afterReply = materialBalance(new Chess(fenAfter[replyPly]), game.playerColor);
    const delta = afterReply - before;
    if (delta < 0) acceptedLosses.push(Math.abs(delta));
  }
  return acceptedLosses;
}

function materialBalance(chess: Chess, playerColor: ParsedGame["playerColor"]): number {
  let white = 0;
  let black = 0;
  for (const row of chess.board()) for (const piece of row) {
    if (!piece) continue;
    const value = PIECE_VALUE[piece.type];
    if (piece.color === "w") white += value;
    else black += value;
  }
  return playerColor === "white" ? white - black : black - white;
}

function pawnShieldScore(chess: Chess, color: ParsedGame["playerColor"]): number {
  const king = chess.board().flat().find((piece) => piece?.type === "k" && piece.color === (color === "white" ? "w" : "b"));
  const kingSquare = chess.board().flatMap((row, rankIndex) => row.map((piece, fileIndex) =>
    piece?.type === "k" && piece.color === (color === "white" ? "w" : "b")
      ? `${String.fromCharCode(97 + fileIndex)}${8 - rankIndex}` : null,
  )).find((square): square is string => square !== null);
  if (!king || !kingSquare) return 0;
  const kingFile = kingSquare.charCodeAt(0) - 97;
  const kingRank = Number(kingSquare[1]);
  const startRank = color === "white" ? 2 : 7;
  let score = 0;
  for (let rank = 1; rank <= 8; rank++) for (let file = Math.max(0, kingFile - 1); file <= Math.min(7, kingFile + 1); file++) {
    const ahead = color === "white" ? rank > kingRank : rank < kingRank;
    const piece = chess.get(`${String.fromCharCode(97 + file)}${rank}` as Square);
    if (ahead && piece?.type === "p" && piece.color === (color === "white" ? "w" : "b")) {
      score += Math.max(0, 1 - Math.abs(rank - startRank) / 6);
    }
  }
  return score;
}

function kingZoneAttackers(chess: Chess, defendedColor: ParsedGame["playerColor"]): number {
  const defended = defendedColor === "white" ? "w" : "b";
  const attacking = defended === "w" ? "b" : "w";
  const board = chess.board();
  let kingFile = -1;
  let kingRank = -1;
  for (let rank = 0; rank < 8; rank++) for (let file = 0; file < 8; file++) {
    const piece = board[rank][file];
    if (piece?.type === "k" && piece.color === defended) { kingFile = file; kingRank = rank; }
  }
  if (kingFile < 0) return 0;
  const targetSquares = new Set<string>();
  for (let rank = Math.max(0, kingRank - 1); rank <= Math.min(7, kingRank + 1); rank++) {
    for (let file = Math.max(0, kingFile - 1); file <= Math.min(7, kingFile + 1); file++) {
      if (rank !== kingRank || file !== kingFile) targetSquares.add(`${String.fromCharCode(97 + file)}${8 - rank}`);
    }
  }
  const fen = chess.fen().split(" ");
  fen[1] = attacking;
  fen[3] = "-";
  let attackPosition: Chess;
  try { attackPosition = new Chess(fen.join(" ")); } catch { return 0; }
  let total = 0;
  for (let rank = 0; rank < 8; rank++) for (let file = 0; file < 8; file++) {
    const piece = board[rank][file];
    if (!piece || piece.color !== attacking) continue;
    const square = `${String.fromCharCode(97 + file)}${8 - rank}` as Square;
    const reachesZone = attackPosition.moves({ square, verbose: true }).some((move) => targetSquares.has(move.to));
    if (reachesZone) total += KING_ZONE_WEIGHT[piece.type];
  }
  return total;
}

/** Named bucket rule: central pawn tension is opposing adjacent-file pawns that can capture. */
export function pawnStructureBucketAt(chess: Chess): number {
  return pawnStructureMetricsAt(chess).bucket;
}

export function pawnStructureMetricsAt(chess: Chess): {
  openOrHalfOpenFiles: number; centralPawnTension: number; bucket: number;
} {
  const board = chess.board();
  let openOrHalfOpenFiles = 0;
  for (let file = 0; file < 8; file++) {
    let white = false;
    let black = false;
    for (let rank = 0; rank < 8; rank++) {
      const piece = board[rank][file];
      if (piece?.type === "p") {
        if (piece.color === "w") white = true;
        else black = true;
      }
    }
    if (!white || !black) openOrHalfOpenFiles++;
  }
  let centralPawnTension = 0;
  for (let rank = 0; rank < 8; rank++) for (let file = 0; file < 8; file++) {
    const pawn = board[rank][file];
    if (pawn?.type !== "p" || !CENTRAL_FILES.has(String.fromCharCode(97 + file))) continue;
    const adjacentRank = rank + (pawn.color === "w" ? -1 : 1);
    for (const adjacentFile of [file - 1, file + 1]) {
      if (adjacentFile < 0 || adjacentFile > 7 || adjacentRank < 0 || adjacentRank > 7) continue;
      const target = board[adjacentRank][adjacentFile];
      if (target?.type === "p" && target.color !== pawn.color) centralPawnTension++;
    }
  }
  centralPawnTension /= 2;
  // Open is deliberately a high threshold; the two signals are kept visible
  // here so §6 feedback can tune this one function without changing pipeline code.
  const bucket = openOrHalfOpenFiles >= 3 && centralPawnTension >= 2
    ? 2
    : openOrHalfOpenFiles >= 2 || centralPawnTension >= 1 ? 1 : 0;
  return { openOrHalfOpenFiles, centralPawnTension, bucket };
}

function computePieceActivityDifferential(
  activity: ReturnType<typeof emptyPieceActivityProfile>["byPieceType"], phase: MatchPhase,
): number {
  const rates: number[] = [];
  for (const piece of Object.keys(activity) as PieceType[]) {
    const stats = activity[piece][phase];
    if (stats.moveCount === 0) continue;
    // Named reduction across the existing per-piece profile: engine-aligned
    // moves minus capture-initiated moves, each as a per-piece rate.
    rates.push(stats.engineTopMatchCount / stats.moveCount - stats.tradeInitiatedCount / stats.moveCount);
  }
  return mean(rates);
}

function computeEvalDeltas(plies: number[], points: Map<number, EvalPoint>): number[] {
  const deltas: number[] = [];
  for (const ply of plies) {
    const point = points.get(ply);
    if (point?.cpBefore === null || point?.cpAfter === null || !point) continue;
    const moverColor = ply % 2 === 0 ? "white" : "black";
    const signToWhite = moverColor === "white" ? 1 : -1;
    deltas.push((point.cpAfter - point.cpBefore) * signToWhite);
  }
  return deltas;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
