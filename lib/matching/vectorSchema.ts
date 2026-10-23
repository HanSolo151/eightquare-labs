export const VECTOR_DIMENSIONS = [
  "materialAggression",
  "kingSafetyDelta",
  "pieceActivityDifferential",
  "pawnStructureBucket",
  "evalVolatility",
] as const;

export const PHASES = ["opening", "middlegame", "endgame"] as const;

export type VectorDimension = (typeof VECTOR_DIMENSIONS)[number];
export type MatchPhase = (typeof PHASES)[number];
export type StyleVector = Record<VectorDimension, number>;

/**
 * Raw feature definitions (normalized per phase against the ingested corpus
 * before storage or matching):
 * - materialAggression: mean pawn-value loss accepted after an own flagged
 *   move and the opponent's immediate reply; equal-value recaptures are
 *   excluded. This measures accepted material loss, not whether it was sound.
 * - kingSafetyDelta: mean change in intact king-shield pawn score after an
 *   own flagged move; the shield sums pawns on the three files around the
 *   king in front of it, each worth max(0, 1 - ranks-from-start / 6).
 *   Positive deltas mean the move strengthened the shield.
 *   kingZoneAttackers (diagnostic only) counts enemy pieces with a legal move
 *   into one of the eight adjacent king squares, weighted queen=3, rook=2,
 *   bishop/knight=1.
 * - pieceActivityDifferential: mean over piece types of engine-top-match rate
 *   minus capture-initiated rate, read from pieceActivityProfile.ts output.
 * - pawnStructureBucket: at the phase midpoint, 0 closed, 1 semi-open,
 *   2 open; thresholds live in the named pawnStructureBucket function.
 * - evalVolatility: population standard deviation of per-ply eval deltas in
 *   White POV (zero when fewer than two scored plies exist).
 * - pawnStructureBucket: open if >=3 files have no pawn on at least one side
 *   and >=2 central pawn-tension pairs; semi-open if >=2 such files or >=1
 *   central tension pair; otherwise closed.
 *
 * `kingZoneAttackers` is retained as diagnostic detail only and deliberately
 * is not part of this five-dimensional vector.
 */
export interface PhaseVectorCalibration {
  means: StyleVector;
  stdDevs: StyleVector;
  sampleSize: number;
}

export type VectorCalibration = Record<MatchPhase, PhaseVectorCalibration>;

export function isStyleVector(value: unknown): value is StyleVector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...VECTOR_DIMENSIONS].sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index] && typeof record[key] === "number" && Number.isFinite(record[key]));
}
