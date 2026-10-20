import { Chess } from "chess.js";
import type { MoveFeature, FlaggedMove } from "@/types";
import { parseSquare } from "./squareGeometry";

const TIME_PRESSURE_CUTOFF_SEC = 30;

export interface SquareStats {
  moveCount: number;
  flaggedCount: number;
  totalCpLoss: number;
  clockDataCount: number;
  under30Count: number;
  flagTypeCounts: Record<string, number>;
}

export type SquareBias = Record<string, SquareStats>;

export interface BiasProfileState {
  squareBias: SquareBias;
  evaluatedGameIds: string[];
  sampleSize: number;
  confidence: "low" | "medium" | "high";
  builtAt: number;
}

function emptyStats(): SquareStats {
  return { moveCount: 0, flaggedCount: 0, totalCpLoss: 0, clockDataCount: 0, under30Count: 0, flagTypeCounts: {} };
}

/** Folds move features and flags into a square map without profile bookkeeping. */
export function foldGameIntoSquareBias(
  squareBias: SquareBias,
  moves: string[],
  moveFeatures: MoveFeature[],
  flags: FlaggedMove[],
  playerColor: "white" | "black"
): void {
  const flagsByPly = new Map<number, FlaggedMove[]>();
  for (const flag of flags) {
    const atPly = flagsByPly.get(flag.ply) ?? [];
    atPly.push(flag);
    flagsByPly.set(flag.ply, atPly);
  }
  const featuresByPly = new Map(moveFeatures.filter((feature) => feature.color === playerColor).map((feature) => [feature.ply, feature]));
  const chess = new Chess();
  for (let ply = 0; ply < moves.length; ply++) {
    let result: ReturnType<Chess["move"]>;
    try { result = chess.move(moves[ply]); } catch { break; }
    const feature = featuresByPly.get(ply);
    if (!result || !feature || !parseSquare(result.to)) continue;
    const stats = squareBias[result.to] ??= emptyStats();
    stats.moveCount++;
    if (feature.clockRemainingSec !== null) {
      stats.clockDataCount++;
      if (feature.clockRemainingSec < TIME_PRESSURE_CUTOFF_SEC) stats.under30Count++;
    }
    const flagsAtPly = flagsByPly.get(ply) ?? [];
    if (flagsAtPly.length > 0) {
      stats.flaggedCount++;
      stats.totalCpLoss += Math.max(...flagsAtPly.map((flag) => flag.cpLoss));
      for (const flag of flagsAtPly) stats.flagTypeCounts[flag.flagType] = (stats.flagTypeCounts[flag.flagType] ?? 0) + 1;
    }
  }
}

/** Folds one game's moves and flags into the profile exactly once. */
export function updateBiasProfile(
  profile: BiasProfileState,
  gameId: string,
  moves: string[],
  moveFeatures: MoveFeature[],
  flags: FlaggedMove[],
  playerColor: "white" | "black"
): BiasProfileState {
  profile.evaluatedGameIds ??= [];
  if (profile.evaluatedGameIds.includes(gameId)) return profile;

  foldGameIntoSquareBias(profile.squareBias, moves, moveFeatures, flags, playerColor);

  profile.evaluatedGameIds.push(gameId);
  profile.sampleSize += new Set(flags.map((flag) => flag.ply)).size;
  profile.confidence = profile.sampleSize >= 60 ? "high" : profile.sampleSize >= 20 ? "medium" : "low";
  profile.builtAt = Date.now();
  return profile;
}
