import { prisma } from "@/lib/prisma";
import type { PlayerProfile, WeaknessProfile } from "@/types";

const RECENT_FLAGS_LIMIT = 10;

/** Reads the signed-in user's persisted dashboard data without recomputing it. */
export async function getDashboardData(userId: string) {
  const [user, profileRow, weaknessRow, totalGames, evaluatedGames, recentFlagRows] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.playerProfile.findUnique({ where: { userId } }),
      prisma.weaknessProfileRow.findUnique({ where: { userId } }),
      prisma.game.count({ where: { userId } }),
      prisma.game.count({ where: { userId, eval: { isNot: null } } }),
      prisma.flaggedMove.findMany({
        where: { game: { userId } },
      orderBy: [
        { game: { lichessCreatedAt: { sort: "desc", nulls: "last" } } },
        { ply: "desc" },
      ],
        take: RECENT_FLAGS_LIMIT,
        include: {
          game: {
            select: {
              id: true,
              lichessGameId: true,
              opponentUsername: true,
              openingName: true,
              openingEco: true,
              result: true,
              lichessCreatedAt: true,
            },
          },
        },
      }),
    ]);

  if (!user) return null;

  const playerProfile: PlayerProfile | null = profileRow
    ? {
        username: user.username,
        gamesAnalyzed: profileRow.gamesAnalyzed,
        avgMoveTimeSecByPhase:
          profileRow.avgMoveTimeSecByPhase as unknown as PlayerProfile["avgMoveTimeSecByPhase"],
        premoveRate: profileRow.premoveRate,
        mostCommonOpenings:
          profileRow.mostCommonOpenings as unknown as PlayerProfile["mostCommonOpenings"],
        avgOpponentRating: profileRow.avgOpponentRating,
      }
    : null;

  const weaknessSummary: Pick<
    WeaknessProfile,
    "gamesEvaluated" | "gamesFetched" | "confidence" | "builtAt"
  > & { patternCount: number } = weaknessRow
    ? {
        gamesEvaluated: weaknessRow.gamesEvaluated,
        gamesFetched: weaknessRow.gamesFetched,
        confidence: weaknessRow.confidence as WeaknessProfile["confidence"],
        builtAt: weaknessRow.builtAt.getTime(),
        patternCount: (weaknessRow.patterns as unknown as { id: string }[]).length,
      }
    : { gamesEvaluated: 0, gamesFetched: 0, confidence: "low", builtAt: 0, patternCount: 0 };

  const recentFlags = recentFlagRows.map((flag) => ({
    gameId: flag.game.lichessGameId,
    opponentUsername: flag.game.opponentUsername,
    openingName: flag.game.openingName,
    openingEco: flag.game.openingEco,
    result: flag.game.result,
    ply: flag.ply,
    moveNumber: flag.moveNumber,
    san: flag.san,
    color: flag.color,
    flagType: flag.flagType,
    severity: flag.severity,
    cpLoss: flag.cpLoss,
    phase: flag.gamePhase,
    explanation: flag.explanation,
  }));

  return {
    username: user.username,
    lastSyncedAt: user.lastSyncedAt,
    totalGames,
    evaluatedGames,
    unevaluatedGames: totalGames - evaluatedGames,
    playerProfile,
    weaknessSummary,
    recentFlags,
  };
}
