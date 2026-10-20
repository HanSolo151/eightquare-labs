import { prisma } from "@/lib/prisma";
import { getBiasData, type BiasData } from "@/lib/bias/getBiasData";
import type { GamePhase, WeaknessPattern } from "@/types";

// Step 4/6: Screen 3 (Patterns). Like getDashboardData, this only reads
// what's already persisted — no Stockfish/engine work happens here.
//
// Board bias is derived from persisted square-level statistics by
// getBiasData; existing games still need evaluation/push before contributing.
//
// Pulled out of app/api/patterns/route.ts so the Patterns screen (a server
// component) can call it directly instead of self-fetching its own route.

// Thresholds currently affecting this page:
// - MIN_GAMES_FOR_OPENING (2 games): opening rate eligibility.
// - MIN_PROFILE_SAMPLES (20 flagged moves): spatial-bias panel eligibility.
// - MIN_SQUARE_MOVES (5 moves per square): square intensity visibility.
// - MIN_AXIS_MOVES (10 moves per aggregate): rank/file/diagonal visibility.
// - MAX_OPENINGS_RETURNED (10) and MAX_WEAKNESS_PATTERNS_RETURNED (8): display limits.
// Weakness confidence is independently derived from gamesEvaluated in
// lib/profile/weaknessProfile.ts (medium >=5 games, high >=15 games).
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

export function openingDrilldownHref(eco: string | null): string | null {
  return eco ? `/dashboard/openings/${encodeURIComponent(eco)}` : null;
}

export type PatternsHeatmap = Record<GamePhase, Record<Severity, number>>;

export interface PatternsWeaknessPattern {
  id: string;
  description: string;
  tags: string[];
  occurrenceCount: number;
  occurrences: { gameId: string; ply: number }[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export const MAX_PATTERN_LINK_OCCURRENCES = 50;

export function weaknessPatternGamesHref(occurrences: { gameId: string; ply: number }[]): string | null {
  if (occurrences.length === 0) return null;
  const linkedOccurrences = occurrences.slice(-MAX_PATTERN_LINK_OCCURRENCES);
  const gameIds = [...new Set(linkedOccurrences.map((occurrence) => occurrence.gameId))];
  const params = new URLSearchParams({
    gameIds: gameIds.join(","),
    occurrences: linkedOccurrences.map(({ gameId, ply }) => `${gameId}:${ply}`).join(","),
    occurrenceCount: String(occurrences.length),
  });
  return `/dashboard/games?${params.toString()}`;
}

const WEAKNESS_PHASE_TAGS = new Set(["opening", "middlegame", "endgame"]);

export function weaknessPatternTagHref(
  tag: string,
  occurrences: { gameId: string; ply: number }[]
): string | null {
  if (!WEAKNESS_PHASE_TAGS.has(tag)) return null;
  const href = weaknessPatternGamesHref(occurrences);
  if (!href) return null;
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  params.set("phase", tag);
  return `/dashboard/games?${params.toString()}`;
}

export function heatmapDrilldownHref(phase: "opening" | "middlegame" | "endgame", severity: "low" | "medium" | "high"): string {
  return `/dashboard/games?${new URLSearchParams({ phase, severity }).toString()}`;
}

export type PatternsBias = BiasData;

export interface PatternsData {
  openings: PatternsOpening[];
  heatmap: PatternsHeatmap;
  weaknessPatterns: PatternsWeaknessPattern[];
  bias: PatternsBias;
  meta: { gamesEvaluated: number; gamesFetched: number; confidence: string };
}

export async function getPatternsData(userId: string): Promise<PatternsData> {
  const [games, flags, weaknessRow, bias] = await Promise.all([
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
    getBiasData(userId),
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
      occurrences: pattern.occurrences,
      firstSeenAt: pattern.firstSeenAt,
      lastSeenAt: pattern.lastSeenAt,
    }));

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
