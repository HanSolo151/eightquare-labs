import { prisma } from "@/lib/prisma";
import { extractMoveFeatures } from "@/lib/features/extractFeatures";
import type { FlaggedMove } from "@/types";
import { foldGameIntoSquareBias, type SquareBias, type SquareStats } from "./updateBiasProfile";
import {
  allSquares,
  antiDiagonalKey,
  antiDiagonalLabel,
  mainDiagonalKey,
  mainDiagonalLabel,
  parseSquare,
} from "./squareGeometry";

export const MIN_PROFILE_SAMPLES = 20;
export const MIN_SQUARE_MOVES = 5;
export const MIN_AXIS_MOVES = 10;
const PRIOR_STRENGTH = 5;

export type HeatmapTheme = "blunderDensity" | "timePressure" | "accuracy";

export interface SquareView {
  square: string;
  value: number;
  flaggedCount: number;
  moveCount: number;
  clockDataCount: number;
  under30Count: number;
  avgCpLoss: number | null;
  topFlagTypes: string[];
  flaggedPositions: { gameId: string; ply: number }[];
}

export interface BiasAxisEntry {
  label: string;
  moveCount: number;
  flaggedCount: number;
  flaggedRate: number;
  timePressureRate: number | null;
}

export interface BiasData {
  meetsThreshold: boolean;
  sampleSize: number;
  squares: Record<HeatmapTheme, SquareView[]>;
  axes: { ranks: BiasAxisEntry[]; files: BiasAxisEntry[]; diagonals: BiasAxisEntry[] };
  caption: string | null;
  availableThemes?: HeatmapTheme[];
  flagOnly?: boolean;
}

function validStats(value: unknown): value is SquareStats {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SquareStats>;
  return Number.isFinite(candidate.moveCount) && Number.isFinite(candidate.flaggedCount) &&
    Number.isFinite(candidate.totalCpLoss) && Number.isFinite(candidate.under30Count) &&
    Number.isFinite(candidate.clockDataCount) && !!candidate.flagTypeCounts &&
    typeof candidate.flagTypeCounts === "object";
}

function safeProfile(value: unknown): SquareBias {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([square, stats]) => parseSquare(square) && validStats(stats))) as SquareBias;
}

export function buildBiasData(
  input: SquareBias,
  sampleSize: number,
  options: { blunderDensityOnly?: boolean } = {}
): BiasData {
  const squareBias = safeProfile(input);
  const availableThemes: HeatmapTheme[] = options.blunderDensityOnly
    ? ["blunderDensity"]
    : ["blunderDensity", "timePressure", "accuracy"];
  const meetsThreshold = sampleSize >= MIN_PROFILE_SAMPLES;

  if (!meetsThreshold) {
    return {
      meetsThreshold,
      sampleSize,
      squares: { blunderDensity: [], timePressure: [], accuracy: [] },
      axes: { ranks: [], files: [], diagonals: [] },
      caption: null,
      availableThemes,
      flagOnly: options.blunderDensityOnly ?? false,
    };
  }

  if (options.blunderDensityOnly) {
    const maxFlagCount = Math.max(0, ...Object.values(squareBias).map((square) => square.flaggedCount));
    const blunderDensity = allSquares().map((square): SquareView => {
      const current = squareBias[square];
      const stats = current ?? { moveCount: 0, flaggedCount: 0, totalCpLoss: 0, clockDataCount: 0, under30Count: 0, flagTypeCounts: {}, flaggedPositions: [] };
      return {
        square,
        // This is a share of recorded flagged moves, not a rate per move.
        value: maxFlagCount > 0 ? stats.flaggedCount / maxFlagCount : 0,
        flaggedCount: stats.flaggedCount,
        moveCount: 0,
        clockDataCount: 0,
        under30Count: 0,
        avgCpLoss: stats.flaggedCount > 0 ? stats.totalCpLoss / stats.flaggedCount : null,
        topFlagTypes: Object.entries(stats.flagTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([type]) => type),
        flaggedPositions: current?.flaggedPositions ?? [],
      };
    });
    return {
      meetsThreshold, sampleSize,
      squares: { blunderDensity, timePressure: [], accuracy: [] },
      axes: { ranks: [], files: [], diagonals: [] },
      caption: null, availableThemes, flagOnly: true,
    };
  }

  const stats = Object.values(squareBias);
  const totalMoves = stats.reduce((sum, square) => sum + square.moveCount, 0);
  const totalFlags = stats.reduce((sum, square) => sum + square.flaggedCount, 0);
  const totalClockedMoves = stats.reduce((sum, square) => sum + square.clockDataCount, 0);
  const totalUnder30 = stats.reduce((sum, square) => sum + square.under30Count, 0);
  const baselineFlagRate = totalMoves > 0 ? totalFlags / totalMoves : 0;
  const baselineTimePressureRate = totalClockedMoves > 0 ? totalUnder30 / totalClockedMoves : 0;

  const build = (theme: HeatmapTheme): SquareView[] => allSquares().map((square) => {
    const current = squareBias[square];
    const s = current ?? { moveCount: 0, flaggedCount: 0, totalCpLoss: 0, clockDataCount: 0, under30Count: 0, flagTypeCounts: {}, flaggedPositions: [] };
    const smoothedFlagRate = (s.flaggedCount + baselineFlagRate * PRIOR_STRENGTH) / (s.moveCount + PRIOR_STRENGTH);
    const smoothedPressureRate = (s.under30Count + baselineTimePressureRate * PRIOR_STRENGTH) / (s.clockDataCount + PRIOR_STRENGTH);
    const riskValue = baselineFlagRate > 0 ? Math.min(1, smoothedFlagRate / (baselineFlagRate * 2)) : 0;
    const pressureValue = baselineTimePressureRate > 0
      ? Math.min(1, smoothedPressureRate / (baselineTimePressureRate * 2))
      : 0;
    const value = theme === "blunderDensity"
      ? riskValue
      : theme === "timePressure"
        ? pressureValue
        : 1 - smoothedFlagRate;

    return {
      square,
      // Sparse squares are left neutral in the UI; their raw counts remain
      // available in the hover/focus detail for transparency.
      value: current && current.moveCount >= MIN_SQUARE_MOVES ? value : 0,
      flaggedCount: s.flaggedCount,
      moveCount: s.moveCount,
      clockDataCount: s.clockDataCount,
      under30Count: s.under30Count,
      avgCpLoss: s.flaggedCount > 0 ? s.totalCpLoss / s.flaggedCount : null,
      topFlagTypes: Object.entries(s.flagTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([type]) => type),
      flaggedPositions: s.flaggedPositions ?? [],
    };
  });

  const diagTotals = new Map<string, { label: string; count: number }>();
  for (const [square, squareStats] of Object.entries(squareBias)) {
    const coord = parseSquare(square);
    if (!coord || squareStats.flaggedCount === 0) continue;
    const diagonalKeys = [
      [`main:${mainDiagonalKey(coord)}`, mainDiagonalLabel(mainDiagonalKey(coord))],
      [`anti:${antiDiagonalKey(coord)}`, antiDiagonalLabel(antiDiagonalKey(coord))],
    ] as const;
    for (const [key, label] of diagonalKeys) {
      const entry = diagTotals.get(key) ?? { label, count: 0 };
      entry.count += squareStats.flaggedCount;
      diagTotals.set(key, entry);
    }
  }
  const topDiagonal = [...diagTotals.values()].sort((a, b) => b.count - a.count)[0];
  const caption = topDiagonal && totalFlags > 0
    ? `${topDiagonal.label} contains ${Math.round((topDiagonal.count / totalFlags) * 100)}% of flagged moves.`
    : null;

  type AxisAccumulator = { moves: number; flags: number; clocked: number; under30: number };
  const ranks = new Map<string, AxisAccumulator>();
  const files = new Map<string, AxisAccumulator>();
  const diagonals = new Map<string, AxisAccumulator>();
  const add = (map: Map<string, AxisAccumulator>, label: string, square: SquareStats) => {
    const item = map.get(label) ?? { moves: 0, flags: 0, clocked: 0, under30: 0 };
    item.moves += square.moveCount;
    item.flags += square.flaggedCount;
    item.clocked += square.clockDataCount;
    item.under30 += square.under30Count;
    map.set(label, item);
  };
  for (const [square, squareStats] of Object.entries(squareBias)) {
    const coord = parseSquare(square);
    if (!coord) continue;
    add(ranks, `Rank ${coord.rank + 1}`, squareStats);
    add(files, `File ${square[0]}`, squareStats);
    add(diagonals, mainDiagonalLabel(mainDiagonalKey(coord)), squareStats);
    add(diagonals, antiDiagonalLabel(antiDiagonalKey(coord)), squareStats);
  }
  const summarize = (map: Map<string, AxisAccumulator>): BiasAxisEntry[] => [...map.entries()]
    .filter(([, item]) => item.moves >= MIN_AXIS_MOVES)
    .map(([label, item]) => ({
      label,
      moveCount: item.moves,
      flaggedCount: item.flags,
      flaggedRate: item.flags / item.moves,
      timePressureRate: item.clocked > 0 ? item.under30 / item.clocked : null,
    }))
    .sort((a, b) => b.flaggedRate - a.flaggedRate);

  return {
    meetsThreshold,
    sampleSize,
    squares: { blunderDensity: build("blunderDensity"), timePressure: build("timePressure"), accuracy: build("accuracy") },
    axes: { ranks: summarize(ranks), files: summarize(files), diagonals: summarize(diagonals) },
    caption,
    availableThemes,
    flagOnly: false,
  };
}

export async function getBiasData(userId: string): Promise<BiasData> {
  // Rebuild from authoritative saved games and flags. Evaluation jobs persist
  // FlaggedMove rows directly; older/background jobs may not have refreshed
  // the denormalized BiasProfile, which otherwise leaves this permanently at 0.
  const games = await prisma.game.findMany({
    where: { userId, eval: { isNot: null } },
    select: {
      id: true,
      playerColor: true,
      opponentUsername: true,
      opponentRating: true,
      playerRating: true,
      moves: true,
      clocks: true,
      clockInitialSec: true,
      clockIncrementSec: true,
      openingName: true,
      openingEco: true,
      result: true,
      rated: true,
      speed: true,
      lichessCreatedAt: true,
      flags: { select: { gameId: true, ply: true, cpLoss: true, flagType: true, color: true } },
    },
  });
  const squareBias: SquareBias = {};
  let sampleSize = 0;
  for (const game of games) {
    const playerColor: "white" | "black" = game.playerColor === "black" ? "black" : "white";
    const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
    const clocks = Array.isArray(game.clocks) && game.clocks.every((clock) => typeof clock === "number" && Number.isFinite(clock))
      ? game.clocks as number[] : null;
    const features = extractMoveFeatures({
      id: game.id,
      playerColor,
      opponentUsername: game.opponentUsername,
      opponentRating: game.opponentRating,
      playerRating: game.playerRating,
      moves,
      clocks,
      clockInitialSec: game.clockInitialSec,
      clockIncrementSec: game.clockIncrementSec,
      openingName: game.openingName,
      openingEco: game.openingEco,
      result: game.result === "win" || game.result === "loss" ? game.result : "draw",
      rated: game.rated,
      speed: game.speed,
      createdAt: game.lichessCreatedAt?.getTime() ?? null,
    });
    const playerFlags = game.flags
      .filter((flag) => flag.color === playerColor)
      .map((flag) => ({ gameId: flag.gameId, ply: flag.ply, cpLoss: flag.cpLoss, flagType: flag.flagType as FlaggedMove["flagType"], color: playerColor }));
    foldGameIntoSquareBias(squareBias, moves, features, playerFlags, playerColor);
    sampleSize += new Set(playerFlags.map((flag) => flag.ply)).size;
  }
  return buildBiasData(squareBias, sampleSize);
}
