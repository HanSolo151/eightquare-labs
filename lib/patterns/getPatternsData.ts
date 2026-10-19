import { prisma } from "@/lib/prisma";
import type { GamePhase, WeaknessPattern } from "@/types";

// Step 4/6: Screen 3 (Patterns). Like getDashboardData, this only reads
// what's already persisted — no Stockfish/engine work happens here.
//
// Caveat: BiasProfile now stores square-level statistics, but those are
// populated as new evaluations are pushed. Existing persisted evaluations
// need a one-time backfill before this can represent the full archive.
// The `bias` field below only exposes the stored aggregates; it does not
// invent values from unrelated metrics.
//
// Pulled out of app/api/patterns/route.ts so the Patterns screen (a server
// component) can call it directly instead of self-fetching its own route.

const MIN_GAMES_FOR_OPENING = 2; // below this, "blunder rate" is noise, not signal
const MAX_OPENINGS_RETURNED = 10;
const MAX_WEAKNESS_PATTERNS_RETURNED = 8;

const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

interface OpeningAgg {
  name: string;
  eco: string | null;
  gameIds: Set<string>;
  flaggedGameIds: Set<string>;
  flagCount: number;
  totalCpLoss: number;
}

export interface PatternsOpening {
  name: string;
  eco: string | null;
  gamesPlayed: number;
  flaggedGameCount: number;
  flagCount: number;
  blunderRate: number;
  avgCpLoss: number;
}

export type PatternsHeatmap = Record<GamePhase, Record<Severity, number>>;

export interface PatternsWeaknessPattern {
  id: string;
  description: string;
  tags: string[];
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type PatternsBias =
  | {
      built: true;
      rankBias: unknown;
      fileBias: unknown;
      diagonalBias: unknown;
      sampleSize: number;
      confidence: string;
    }
  | { built: false; reason: "bias engine not implemented yet" };

export interface PatternsData {
  openings: PatternsOpening[];
  heatmap: PatternsHeatmap;
  weaknessPatterns: PatternsWeaknessPattern[];
  bias: PatternsBias;
  meta: { gamesEvaluated: number; gamesFetched: number; confidence: string };
}

export async function getPatternsData(userId: string): Promise<PatternsData> {
  const [games, flags, weaknessRow, biasRow] = await Promise.all([
    prisma.game.findMany({
      where: { userId },
      select: { id: true, openingName: true, openingEco: true },
    }),
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      select: {
        gameId: true,
        gamePhase: true,
        severity: true,
        cpLoss: true,
        game: { select: { openingName: true, openingEco: true } },
      },
    }),
    prisma.weaknessProfileRow.findUnique({ where: { userId } }),
    prisma.biasProfile.findUnique({ where: { userId } }),
  ]);

  // --- Openings ranked by blunder rate ---------------------------------
  const openingAgg = new Map<string, OpeningAgg>();
  for (const game of games) {
    if (!game.openingName) continue;
    const key = game.openingName;
    const existing = openingAgg.get(key);
    if (existing) existing.gameIds.add(game.id);
    else
      openingAgg.set(key, {
        name: game.openingName,
        eco: game.openingEco,
        gameIds: new Set([game.id]),
        flaggedGameIds: new Set(),
        flagCount: 0,
        totalCpLoss: 0,
      });
  }
  for (const flag of flags) {
    const name = flag.game.openingName;
    if (!name) continue;
    const agg = openingAgg.get(name);
    if (!agg) continue; // shouldn't happen — flag's game wasn't in `games`
    agg.flagCount += 1;
    agg.flaggedGameIds.add(flag.gameId);
    agg.totalCpLoss += flag.cpLoss;
  }

  const openings: PatternsOpening[] = [...openingAgg.values()]
    .filter((o) => o.gameIds.size >= MIN_GAMES_FOR_OPENING)
    .map((o) => ({
      name: o.name,
      eco: o.eco,
      gamesPlayed: o.gameIds.size,
      flaggedGameCount: o.flaggedGameIds.size,
      flagCount: o.flagCount,
      blunderRate: o.flaggedGameIds.size / o.gameIds.size,
      avgCpLoss: o.flagCount > 0 ? Math.round(o.totalCpLoss / o.flagCount) : 0,
    }))
    .sort((a, b) => b.blunderRate - a.blunderRate)
    .slice(0, MAX_OPENINGS_RETURNED);

  // --- Heatmap: flag density by game phase x severity -------------------
  const phases: GamePhase[] = ["opening", "middlegame", "endgame"];
  const heatmap: PatternsHeatmap = {
    opening: { low: 0, medium: 0, high: 0 },
    middlegame: { low: 0, medium: 0, high: 0 },
    endgame: { low: 0, medium: 0, high: 0 },
  };
  for (const flag of flags) {
    const phase = flag.gamePhase as GamePhase;
    const severity = flag.severity as Severity;
    if (phases.includes(phase) && SEVERITIES.includes(severity)) {
      heatmap[phase][severity] += 1;
    }
  }

  // --- Weakness patterns (from Step 3's WeaknessProfileRow) --------------
  const patterns: WeaknessPattern[] = weaknessRow
    ? (weaknessRow.patterns as unknown as WeaknessPattern[])
    : [];
  const weaknessPatterns: PatternsWeaknessPattern[] = [...patterns]
    .sort((a, b) => b.occurrences.length - a.occurrences.length)
    .slice(0, MAX_WEAKNESS_PATTERNS_RETURNED)
    .map((pattern) => ({
      id: pattern.id,
      description: pattern.description,
      tags: pattern.tags,
      occurrenceCount: pattern.occurrences.length,
      firstSeenAt: pattern.firstSeenAt,
      lastSeenAt: pattern.lastSeenAt,
    }));

  // --- Bias (rank/file/diagonal) -----------------------------------------
  const bias: PatternsBias = biasRow
    ? {
        built: true,
        rankBias: biasRow.rankBias,
        fileBias: biasRow.fileBias,
        diagonalBias: biasRow.diagonalBias,
        sampleSize: biasRow.sampleSize,
        confidence: biasRow.confidence,
      }
    : { built: false, reason: "bias engine not implemented yet" };

  return {
    openings,
    heatmap,
    weaknessPatterns,
    bias,
    meta: {
      gamesEvaluated: weaknessRow?.gamesEvaluated ?? 0,
      gamesFetched: weaknessRow?.gamesFetched ?? 0,
      confidence: weaknessRow?.confidence ?? "low",
    },
  };
}
