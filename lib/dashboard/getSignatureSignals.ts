import { prisma } from "@/lib/prisma";
import type { WeaknessPattern } from "@/types";

const CP_TREND_THRESHOLD = 25;

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2021";
}

export interface PatternProgressDelta {
  patternId: string;
  description: string;
  phase: "opening" | "middlegame" | "endgame";
  trend: "improving" | "steady" | "worsening" | "baseline" | "untrained";
  beforeAvgCp: number;
  afterAvgCp: number;
  beforeCount: number;
  afterCount: number;
  beforeGameCount: number;
  evidence: { gameId: string; ply: number; san: string; opponentUsername: string; playedAt: string; cpLoss: number }[];
  latestAfter: { opponentUsername: string; playedAt: string; cpLoss: number } | null;
}

export interface AmbientPaceAggregate {
  gameCount: number;
  openingName: string;
  phase: string;
}

export interface SelfCpLossTrend {
  trend: "improving" | "steady" | "worsening";
  recentAvgCp: number;
  previousAvgCp: number;
  recentCount: number;
  previousCount: number;
}

/** A descriptive comparison of recent player move flags, not a rating estimate. */
export async function getSelfCpLossTrend(userId: string): Promise<SelfCpLossTrend | null> {
  const rows = await prisma.flaggedMove.findMany({
    where: { game: { userId } },
    orderBy: [{ game: { lichessCreatedAt: { sort: "desc", nulls: "last" } } }, { ply: "desc" }],
    take: 600,
    select: { gameId: true, ply: true, cpLoss: true, color: true, game: { select: { playerColor: true } } },
  });
  const strongestByPosition = new Map<string, { cpLoss: number; gameId: string; ply: number }>();
  for (const row of rows) {
    if (row.color !== row.game.playerColor) continue;
    const key = `${row.gameId}:${row.ply}`;
    const previous = strongestByPosition.get(key);
    if (!previous || row.cpLoss > previous.cpLoss) strongestByPosition.set(key, row);
  }
  // Preserve the date order from the query while deduplicating multiple flag
  // types attached to a single move.
  const ordered = [...strongestByPosition.values()];
  const recent = ordered.slice(0, 10).map((row) => row.cpLoss);
  const previous = ordered.slice(10, 20).map((row) => row.cpLoss);
  if (recent.length < 3 || previous.length < 3) return null;
  const recentAvgCp = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const previousAvgCp = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  const change = recentAvgCp - previousAvgCp;
  return {
    trend: change <= -CP_TREND_THRESHOLD ? "improving" : change >= CP_TREND_THRESHOLD ? "worsening" : "steady",
    recentAvgCp: Math.round(recentAvgCp),
    previousAvgCp: Math.round(previousAvgCp),
    recentCount: recent.length,
    previousCount: previous.length,
  };
}

/** Compare only recorded occurrences of a pattern, anchored by a spar resolution
 * for one of those exact game/ply positions. This avoids guessing which pattern
 * a generic resolved position was intended to represent.
 */
export async function getPatternProgressDeltas(userId: string): Promise<PatternProgressDelta[]> {
  const profile = await prisma.weaknessProfileRow.findUnique({ where: { userId }, select: { patterns: true } });
  const patterns = (profile?.patterns ?? []) as unknown as WeaknessPattern[];
  const occurrenceKeys = [...new Set(patterns.flatMap((pattern) => pattern.occurrences.map(({ gameId }) => gameId)))];
  if (!occurrenceKeys.length) return [];
  const games = await prisma.game.findMany({
    where: { userId, lichessGameId: { in: occurrenceKeys } },
    select: { id: true, lichessGameId: true, lichessCreatedAt: true },
  });
  const internalGameIds = games.map((game) => game.id);
  const [occurrences, resolutions] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { gameId: { in: internalGameIds } },
      select: { gameId: true, ply: true, cpLoss: true, san: true, game: { select: { id: true, opponentUsername: true } } },
    }),
    prisma.resolvedSparPosition.findMany({
      where: { userId, gameId: { in: internalGameIds } },
      select: { gameId: true, ply: true, resolvedAt: true },
    }).catch((error: unknown) => {
      if (isMissingTable(error)) return [];
      throw error;
    }),
  ]);
  const gameByInternalId = new Map(games.map((game) => [game.id, game]));
  const flagByPosition = new Map<string, { cpLoss: number; playedAt: Date; gameId: string; san: string; opponentUsername: string }>();
  for (const flag of occurrences) {
    const game = gameByInternalId.get(flag.gameId);
    if (!game?.lichessCreatedAt) continue;
    // Weakness profiles are built before persistence and keyed by Lichess IDs;
    // DB relations use internal Game IDs. Join through the external game ID.
    const key = `${game.lichessGameId}:${flag.ply}`;
    const previous = flagByPosition.get(key);
    if (!previous || flag.cpLoss > previous.cpLoss) {
      flagByPosition.set(key, { cpLoss: flag.cpLoss, playedAt: game.lichessCreatedAt, gameId: flag.game.id, san: flag.san, opponentUsername: flag.game.opponentUsername });
    }
  }

  const resolutionByPosition = new Map(resolutions.flatMap((item) => {
    const game = gameByInternalId.get(item.gameId);
    return game ? [[`${game.lichessGameId}:${item.ply}`, item.resolvedAt] as const] : [];
  }));
  const deltas: PatternProgressDelta[] = [];
  for (const pattern of patterns) {
    const linkedResolutions = pattern.occurrences
      .map(({ gameId, ply }) => resolutionByPosition.get(`${gameId}:${ply}`))
      .filter((date): date is Date => date !== undefined)
      .sort((a, b) => a.getTime() - b.getTime());
    const firstResolution = linkedResolutions[0] ?? null;

    const before: number[] = [];
    const after: number[] = [];
    const evidence: PatternProgressDelta["evidence"] = [];
    let latestAfter: PatternProgressDelta["latestAfter"] = null;
    for (const occurrence of pattern.occurrences) {
      const flag = flagByPosition.get(`${occurrence.gameId}:${occurrence.ply}`);
      if (!flag) continue;
      if (!firstResolution || flag.playedAt < firstResolution) {
        before.push(flag.cpLoss);
        evidence.push({ gameId: flag.gameId, ply: occurrence.ply, san: flag.san, opponentUsername: flag.opponentUsername, playedAt: flag.playedAt.toISOString(), cpLoss: flag.cpLoss });
      } else {
        after.push(flag.cpLoss);
        if (!latestAfter || flag.playedAt.toISOString() > latestAfter.playedAt) {
          latestAfter = { opponentUsername: flag.opponentUsername, playedAt: flag.playedAt.toISOString(), cpLoss: flag.cpLoss };
        }
      }
    }
    if (before.length === 0) continue;
    const beforeAvgCp = before.reduce((sum, value) => sum + value, 0) / before.length;
    const afterAvgCp = after.length ? after.reduce((sum, value) => sum + value, 0) / after.length : 0;
    const change = afterAvgCp - beforeAvgCp;
    deltas.push({
      patternId: pattern.id,
      description: pattern.description,
      phase: pattern.tags.find((tag): tag is "opening" | "middlegame" | "endgame" => tag === "opening" || tag === "middlegame" || tag === "endgame") ?? "middlegame",
      trend: !firstResolution ? "untrained" : after.length === 0 ? "baseline" : change <= -CP_TREND_THRESHOLD ? "improving" : change >= CP_TREND_THRESHOLD ? "worsening" : "steady",
      beforeAvgCp: Math.round(beforeAvgCp),
      afterAvgCp: Math.round(afterAvgCp),
      beforeCount: before.length,
      afterCount: after.length,
      beforeGameCount: new Set(evidence.map((item) => item.gameId)).size,
      evidence: evidence.sort((a, b) => b.playedAt.localeCompare(a.playedAt)),
      latestAfter,
    });
  }
  return deltas;
}

/** Retrospective count of this month's per-game pace-collapse signals. */
export async function getAmbientPaceAggregate(userId: string, now = new Date()): Promise<AmbientPaceAggregate | null> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await prisma.flaggedMove.findMany({
    where: {
      flagType: "tilt_cascade",
      game: { userId, lichessCreatedAt: { gte: monthStart } },
    },
    select: { gameId: true, gamePhase: true, game: { select: { openingName: true } } },
  });
  const groups = new Map<string, { gameIds: Set<string>; openingName: string; phase: string }>();
  for (const row of rows) {
    if (!row.game.openingName) continue;
    const key = `${row.game.openingName}\u0000${row.gamePhase}`;
    const group = groups.get(key) ?? { gameIds: new Set<string>(), openingName: row.game.openingName, phase: row.gamePhase };
    group.gameIds.add(row.gameId);
    groups.set(key, group);
  }
  const top = [...groups.values()].sort((a, b) => b.gameIds.size - a.gameIds.size)[0];
  return top && top.gameIds.size >= 3
    ? { gameCount: top.gameIds.size, openingName: top.openingName, phase: top.phase }
    : null;
}
