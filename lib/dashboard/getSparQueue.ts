import { prisma } from "@/lib/prisma";

export interface SparQueueItem {
  gameId: string;
  ply: number;
  summary: string;
  severity: string;
}

export interface SparQueueSnapshot {
  items: SparQueueItem[];
  total: number;
  resolved: number;
  flagged: number;
  trackingAvailable: boolean;
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2021";
}

/** Persisted flagged positions not already solved in Daily or the spar flow. */
export async function getSparQueue(userId: string, limit = 8): Promise<SparQueueSnapshot> {
  const [flags, dailyResult, sparResult] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      select: {
        gameId: true, ply: true, moveNumber: true, severity: true,
        flagType: true, cpLoss: true, color: true,
        game: { select: { opponentUsername: true, playerColor: true } },
      },
    }),
    prisma.dailyPuzzleState.findMany({
      where: { userId, status: "solved" },
      select: { gameId: true, ply: true },
    }).then((items) => ({ items, available: true as const })).catch((error: unknown) => {
      if (isMissingTable(error)) return { items: [], available: false as const };
      throw error;
    }),
    prisma.resolvedSparPosition.findMany({
      where: { userId },
      select: { gameId: true, ply: true },
    }).then((items) => ({ items, available: true as const })).catch((error: unknown) => {
      if (isMissingTable(error)) return { items: [], available: false as const };
      throw error;
    }),
  ]);
  const solvedKeys = new Set([
    ...dailyResult.items.map((item) => `${item.gameId}:${item.ply}`),
    ...sparResult.items.map((item) => `${item.gameId}:${item.ply}`),
  ]);
  // The practice queue is about the signed-in player's decisions. Older
  // analysis rows may also contain opponent moves, which must not inflate
  // the queue or lead to a drill that cannot be played as the user.
  const playerFlags = flags.filter((flag) => flag.color === flag.game.playerColor);
  playerFlags.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    b.cpLoss - a.cpLoss || a.ply - b.ply
  );

  // A single move may carry more than one diagnostic flag. Queue/progress
  // counts are position counts, so keep only the strongest record per ply.
  const uniqueByPosition = new Map<string, typeof playerFlags[number]>();
  for (const flag of playerFlags) {
    const key = `${flag.gameId}:${flag.ply}`;
    if (!uniqueByPosition.has(key)) uniqueByPosition.set(key, flag);
  }
  const uniqueFlags = [...uniqueByPosition.values()];
  const unresolved = uniqueFlags.filter((flag) => !solvedKeys.has(`${flag.gameId}:${flag.ply}`));

  const result: SparQueueItem[] = [];
  for (const flag of unresolved) {
    result.push({
      gameId: flag.gameId,
      ply: flag.ply,
      severity: flag.severity,
      summary: `${flag.flagType.replace(/_/g, " ")}, move ${flag.moveNumber}, vs. ${flag.game.opponentUsername}`,
    });
    if (result.length >= limit) break;
  }
  return {
    items: result,
    total: unresolved.length,
    resolved: uniqueFlags.length - unresolved.length,
    flagged: uniqueFlags.length,
    trackingAvailable: dailyResult.available && sparResult.available,
  };
}
