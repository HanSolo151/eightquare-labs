import { prisma } from "@/lib/prisma";

export interface SparQueueItem {
  gameId: string;
  ply: number;
  summary: string;
  severity: string;
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Persisted flagged positions not already marked solved in Daily Puzzle. */
export async function getSparQueue(userId: string, limit = 8): Promise<SparQueueItem[]> {
  const [flags, solved] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      select: {
        gameId: true, ply: true, moveNumber: true, severity: true,
        flagType: true, cpLoss: true,
        game: { select: { opponentUsername: true } },
      },
    }),
    prisma.dailyPuzzleState.findMany({
      where: { userId, status: "solved" },
      select: { gameId: true, ply: true },
    }),
  ]);
  const solvedKeys = new Set(solved.map((item) => `${item.gameId}:${item.ply}`));
  const unresolved = flags.filter((flag) => !solvedKeys.has(`${flag.gameId}:${flag.ply}`));
  unresolved.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    b.cpLoss - a.cpLoss || a.ply - b.ply
  );

  const seen = new Set<string>();
  const result: SparQueueItem[] = [];
  for (const flag of unresolved) {
    const key = `${flag.gameId}:${flag.ply}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      gameId: flag.gameId,
      ply: flag.ply,
      severity: flag.severity,
      summary: `${flag.flagType.replace(/_/g, " ")}, move ${flag.moveNumber}, vs. ${flag.game.opponentUsername}`,
    });
    if (result.length >= limit) break;
  }
  return result;
}
