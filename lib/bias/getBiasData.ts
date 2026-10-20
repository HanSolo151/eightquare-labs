import { prisma } from "@/lib/prisma";
import {
  allSquares,
  antiDiagonalKey,
  antiDiagonalLabel,
  mainDiagonalKey,
  mainDiagonalLabel,
  parseSquare,
} from "./squareGeometry";
import type { SquareBias, SquareStats } from "./updateBiasProfile";

const MIN_PROFILE_SAMPLES = 20;
const MIN_SQUARE_MOVES = 5;
const PRIOR_STRENGTH = 5;

export type HeatmapTheme = "blunderDensity" | "timePressure" | "accuracy";

export interface SquareView {
  square: string;
  value: number;
  flaggedCount: number;
  moveCount: number;
  clockDataCount: number;
  avgCpLoss: number | null;
  topFlagTypes: string[];
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
      const stats = current ?? { moveCount: 0, flaggedCount: 0, totalCpLoss: 0, clockDataCount: 0, under30Count: 0, flagTypeCounts: {} };
      return {
        square,
        // This is a share of recorded flagged moves, not a rate per move.
        value: maxFlagCount > 0 ? stats.flaggedCount / maxFlagCount : 0,
        flaggedCount: stats.flaggedCount,
        moveCount: 0,
        clockDataCount: 0,
        avgCpLoss: stats.flaggedCount > 0 ? stats.totalCpLoss / stats.flaggedCount : null,
        topFlagTypes: Object.entries(stats.flagTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([type]) => type),
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
    const s = current ?? { moveCount: 0, flaggedCount: 0, totalCpLoss: 0, clockDataCount: 0, under30Count: 0, flagTypeCounts: {} };
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
      avgCpLoss: s.flaggedCount > 0 ? s.totalCpLoss / s.flaggedCount : null,
      topFlagTypes: Object.entries(s.flagTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([type]) => type),
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
    .filter(([, item]) => item.moves >= 10)
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
  const row = await prisma.biasProfile.findUnique({ where: { userId } });
  return buildBiasData(safeProfile(row?.squareBias), row?.sampleSize ?? 0);
}
