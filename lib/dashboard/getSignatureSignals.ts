import { prisma } from "@/lib/prisma";
import type { EvalPoint, WeaknessPattern } from "@/types";
import { toPlayerPerspective } from "@/lib/eval/toPlayerPerspective";

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

export interface OpeningBreadth {
  distinctEcoCount: number;
  gamesWithEco: number;
  gamesWithoutEco: number;
}

/** Count distinct recorded ECO codes and separately report games without one. */
export async function getOpeningBreadth(userId: string): Promise<OpeningBreadth> {
  const [ecoRows, gamesWithEco, gamesWithoutEco] = await Promise.all([
    prisma.game.findMany({
      where: { userId, openingEco: { not: null } },
      select: { openingEco: true },
      distinct: ["openingEco"],
    }),
    prisma.game.count({ where: { userId, openingEco: { not: null } } }),
    prisma.game.count({ where: { userId, openingEco: null } }),
  ]);
  return { distinctEcoCount: ecoRows.length, gamesWithEco, gamesWithoutEco };
}

export interface ComebackIndex {
  comebackWinCount: number;
  totalWinCount: number;
  evaluatedWinCount: number;
  comebackShare: number;
}

const COMEBACK_INDEX_THRESHOLD_CP = -200;
const COMEBACK_INDEX_MIN_EVAL_DEPTH = 10;

/** Share of evaluated wins that recovered from a 2-pawn deficit or forced mate. */
export async function getComebackIndex(userId: string): Promise<ComebackIndex> {
  const [totalWinCount, evaluatedWins] = await Promise.all([
    prisma.game.count({ where: { userId, result: "win" } }),
    prisma.game.findMany({
      where: { userId, result: "win", eval: { isNot: null } },
      select: { playerColor: true, eval: { select: { points: true } } },
    }),
  ]);

  let evaluatedWinCount = 0;
  let comebackWinCount = 0;
  for (const game of evaluatedWins) {
    if (game.playerColor !== "white" && game.playerColor !== "black") continue;
    const points = game.eval?.points;
    if (!Array.isArray(points)) continue;
    let hasUsableEvaluation = false;
    let isComeback = false;
    for (const raw of points) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const point = raw as Partial<EvalPoint>;
      if (!Number.isInteger(point.ply) || point.ply! < 0 || !Number.isFinite(point.depth) || point.depth! < COMEBACK_INDEX_MIN_EVAL_DEPTH) continue;

      if (typeof point.cpAfter === "number" && Number.isFinite(point.cpAfter)) {
        hasUsableEvaluation = true;
        if (toPlayerPerspective(point.cpAfter, point.ply!, game.playerColor) <= COMEBACK_INDEX_THRESHOLD_CP) isComeback = true;
      } else if (typeof point.mateAfter === "number" && Number.isFinite(point.mateAfter)) {
        hasUsableEvaluation = true;
        if (toPlayerPerspective(point.mateAfter, point.ply!, game.playerColor) < 0) isComeback = true;
      }
    }
    if (!hasUsableEvaluation) continue;
    evaluatedWinCount++;
    if (isComeback) comebackWinCount++;
  }

  return {
    comebackWinCount,
    totalWinCount,
    evaluatedWinCount,
    comebackShare: evaluatedWinCount > 0 ? comebackWinCount / evaluatedWinCount : 0,
  };
}

export interface BlunderHourStats {
  byHour: { hour: number; gameCount: number; flagsPerGame: number }[];
  worstHour: { hour: number; flagsPerGame: number } | null;
  bestHour: { hour: number; flagsPerGame: number } | null;
  overallFlagsPerGame: number;
}

const MIN_BLUNDER_HOUR_GAMES = 5;

/** Player-colored flagged moves per game grouped by UTC game-start hour. */
export async function getBlunderHourStats(userId: string): Promise<BlunderHourStats> {
  const games = await prisma.game.findMany({
    where: { userId, lichessCreatedAt: { not: null } },
    select: {
      playerColor: true,
      lichessCreatedAt: true,
      flags: { select: { color: true } },
    },
  });
  const buckets = new Map<number, { gameCount: number; flagCount: number }>();
  let totalFlags = 0;
  for (const game of games) {
    if (!game.lichessCreatedAt) continue;
    const hour = game.lichessCreatedAt.getUTCHours();
    const ownFlags = game.flags.filter((flag) => flag.color === game.playerColor).length;
    const bucket = buckets.get(hour) ?? { gameCount: 0, flagCount: 0 };
    bucket.gameCount++;
    bucket.flagCount += ownFlags;
    totalFlags += ownFlags;
    buckets.set(hour, bucket);
  }

  const byHour = [...buckets.entries()]
    .map(([hour, bucket]) => ({ hour, gameCount: bucket.gameCount, flagsPerGame: bucket.flagCount / bucket.gameCount }))
    .sort((a, b) => a.hour - b.hour);
  const eligible = byHour.filter((bucket) => bucket.gameCount >= MIN_BLUNDER_HOUR_GAMES);
  const worst = [...eligible].sort((a, b) => b.flagsPerGame - a.flagsPerGame)[0] ?? null;
  const best = [...eligible].sort((a, b) => a.flagsPerGame - b.flagsPerGame)[0] ?? null;
  return {
    byHour,
    worstHour: worst ? { hour: worst.hour, flagsPerGame: worst.flagsPerGame } : null,
    bestHour: best ? { hour: best.hour, flagsPerGame: best.flagsPerGame } : null,
    overallFlagsPerGame: games.length ? totalFlags / games.length : 0,
  };
}

export interface PersonalRecords {
  biggestComeback: {
    gameId: string;
    ply: number;
    opponentUsername: string;
    worstCpForPlayer: number | null;
    forcedMateAgainstPlayerIn: number | null;
    playedAt: string | null;
  } | null;
  longestWin: { gameId: string; opponentUsername: string; plyCount: number; playedAt: string | null } | null;
  bestWinVsHigherRated: { gameId: string; opponentUsername: string; ratingGap: number; opponentRating: number; playedAt: string | null } | null;
}

const MIN_COMEBACK_EVAL_DEPTH = 10;
const FORCED_MATE_SORT_SCORE = 1_000_000;
type ComebackCandidate = {
  rank: number;
  ply: number;
  cpForPlayer: number | null;
  forcedMateAgainstPlayerIn: number | null;
};

/**
 * Compute only records supported by saved game data. A comeback requires a
 * win plus at least one depth-10 evaluation showing a 3-pawn deficit or a
 * forced mate against the player. Mate scores are ranked separately and are
 * never displayed as centipawns.
 */
export async function getPersonalRecords(userId: string): Promise<PersonalRecords> {
  const [wonGames, evaluatedWins] = await Promise.all([
    prisma.game.findMany({
      where: { userId, result: "win" },
      select: {
        id: true,
        opponentUsername: true,
        opponentRating: true,
        playerRating: true,
        moves: true,
        lichessCreatedAt: true,
      },
    }),
    prisma.game.findMany({
      where: { userId, result: "win", eval: { isNot: null } },
      select: {
        id: true,
        playerColor: true,
        eval: { select: { points: true } },
      },
    }),
  ]);

  let biggestComeback: PersonalRecords["biggestComeback"] = null;
  let longestWin: PersonalRecords["longestWin"] = null;
  let bestWinVsHigherRated: PersonalRecords["bestWinVsHigherRated"] = null;

  for (const game of wonGames) {
    const plyCount = Array.isArray(game.moves)
      ? game.moves.filter((move): move is string => typeof move === "string").length
      : 0;
    const playedAt = game.lichessCreatedAt?.toISOString() ?? null;

    if (plyCount > 0 && (!longestWin || plyCount > longestWin.plyCount)) {
      longestWin = { gameId: game.id, opponentUsername: game.opponentUsername, plyCount, playedAt };
    }

    if (game.opponentRating !== null && game.playerRating !== null) {
      const ratingGap = game.opponentRating - game.playerRating;
      if (ratingGap > 0 && (!bestWinVsHigherRated || ratingGap > bestWinVsHigherRated.ratingGap)) {
        bestWinVsHigherRated = {
          gameId: game.id,
          opponentUsername: game.opponentUsername,
          ratingGap,
          opponentRating: game.opponentRating,
          playedAt,
        };
      }
    }
  }

  const wonGameById = new Map(wonGames.map((game) => [game.id, game]));
  let biggestComebackRank = Number.POSITIVE_INFINITY;
  for (const game of evaluatedWins) {
    const gameSummary = wonGameById.get(game.id);
    if (!gameSummary || (game.playerColor !== "white" && game.playerColor !== "black")) continue;
    const rawPoints = game.eval?.points;
    if (!Array.isArray(rawPoints)) continue;

    let gameWorst: ComebackCandidate | null = null;

    for (const raw of rawPoints) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const point = raw as Partial<EvalPoint>;
      if (!Number.isInteger(point.ply) || point.ply! < 0 || !Number.isFinite(point.depth) || point.depth! < MIN_COMEBACK_EVAL_DEPTH) continue;

      let candidate: ComebackCandidate | null = null;
      if (typeof point.cpAfter === "number" && Number.isFinite(point.cpAfter)) {
        const cpForPlayer = toPlayerPerspective(point.cpAfter, point.ply!, game.playerColor);
        candidate = { rank: cpForPlayer, ply: point.ply!, cpForPlayer, forcedMateAgainstPlayerIn: null };
      } else if (typeof point.mateAfter === "number" && Number.isFinite(point.mateAfter) && point.mateAfter !== 0) {
        const mateForPlayer = toPlayerPerspective(point.mateAfter, point.ply!, game.playerColor);
        const mateDistance = Math.abs(mateForPlayer);
        candidate = {
          rank: mateForPlayer < 0
            ? -FORCED_MATE_SORT_SCORE + mateDistance / (mateDistance + 1)
            : FORCED_MATE_SORT_SCORE,
          ply: point.ply!,
          cpForPlayer: null,
          forcedMateAgainstPlayerIn: mateForPlayer < 0 ? mateDistance : null,
        };
      }
      if (!candidate) continue;

      const isMoreSevereMate = gameWorst?.forcedMateAgainstPlayerIn !== null &&
        gameWorst?.forcedMateAgainstPlayerIn !== undefined &&
        candidate.forcedMateAgainstPlayerIn !== null &&
        candidate.forcedMateAgainstPlayerIn < gameWorst.forcedMateAgainstPlayerIn;
      if (!gameWorst || candidate.rank < gameWorst.rank || isMoreSevereMate) gameWorst = candidate;
    }

    const qualifies = gameWorst && (
      gameWorst.forcedMateAgainstPlayerIn !== null ||
      (gameWorst.cpForPlayer !== null && gameWorst.cpForPlayer <= -300)
    );
    if (!qualifies || !gameWorst || gameWorst.rank >= biggestComebackRank) continue;

    biggestComebackRank = gameWorst.rank;
    biggestComeback = {
      gameId: game.id,
      ply: gameWorst.ply,
      opponentUsername: gameSummary.opponentUsername,
      worstCpForPlayer: gameWorst.cpForPlayer,
      forcedMateAgainstPlayerIn: gameWorst.forcedMateAgainstPlayerIn,
      playedAt: gameSummary.lichessCreatedAt?.toISOString() ?? null,
    };
  }

  return { biggestComeback, longestWin, bestWinVsHigherRated };
}

export interface MostExpensiveMove {
  gameId: string;
  ply: number;
  san: string;
  moveNumber: number;
  cpLoss: number;
  opponentUsername: string;
  playedAt: string | null;
}

/** Largest recorded loss from one of the account holder's own moves. */
export async function getMostExpensiveMove(userId: string): Promise<MostExpensiveMove | null> {
  const [whiteMove, blackMove] = await Promise.all([
    prisma.flaggedMove.findFirst({
      where: { color: "white", game: { userId, playerColor: "white" } },
      orderBy: { cpLoss: "desc" },
      select: {
        gameId: true,
        ply: true,
        san: true,
        moveNumber: true,
        cpLoss: true,
        game: { select: { opponentUsername: true, lichessCreatedAt: true } },
      },
    }),
    prisma.flaggedMove.findFirst({
      where: { color: "black", game: { userId, playerColor: "black" } },
      orderBy: { cpLoss: "desc" },
      select: {
        gameId: true,
        ply: true,
        san: true,
        moveNumber: true,
        cpLoss: true,
        game: { select: { opponentUsername: true, lichessCreatedAt: true } },
      },
    }),
  ]);
  const row = !whiteMove ? blackMove : !blackMove ? whiteMove : whiteMove.cpLoss >= blackMove.cpLoss ? whiteMove : blackMove;
  if (!row) return null;
  return {
    gameId: row.gameId,
    ply: row.ply,
    san: row.san,
    moveNumber: row.moveNumber,
    cpLoss: row.cpLoss,
    opponentUsername: row.game.opponentUsername,
    playedAt: row.game.lichessCreatedAt?.toISOString() ?? null,
  };
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
