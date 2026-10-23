import { prisma } from "@/lib/prisma";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { isVanityEvaluationEligible } from "@/lib/matching/vanityEligibility";

export type SyncResult =
  | {
      ok: true;
      synced: number;
      totalGames: number;
      lastSyncedAt: Date;
      lastGameCreatedAt: Date | null;
      skipped: boolean;
    }
  | { ok: false; error: string };

// Passive page loads are throttled so repeated dashboard visits don't
// repeatedly call Lichess. Explicit sync requests can bypass this interval.
const MIN_SYNC_INTERVAL_MS = 60 * 1000;

/**
 * Incremental Lichess -> Game table sync for one user.
 * Shared by POST /api/sync and the dashboard server component.
 */
export async function runSync(
  userId: string,
  opts: { force?: boolean } = {}
): Promise<SyncResult> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { ok: false, error: "user not found" };

    if (!opts.force && user.lastSyncedAt) {
      const msSinceLastSync = Date.now() - user.lastSyncedAt.getTime();
      if (msSinceLastSync < MIN_SYNC_INTERVAL_MS) {
        const totalGames = await prisma.game.count({ where: { userId: user.id } });
        return {
          ok: true,
          synced: 0,
          totalGames,
          lastSyncedAt: user.lastSyncedAt,
          lastGameCreatedAt: user.lastGameCreatedAt,
          skipped: true,
        };
      }
    }

    const since = user.lastGameCreatedAt?.getTime();
    const pageSize = since ? 200 : 25;
    const raw: Awaited<ReturnType<typeof fetchGames>> = [];
    let until: number | undefined;

    // Lichess returns newest games first. A fixed 200-game incremental
    // request must not advance the watermark past older games in that same
    // window. Walk backward with `until` until the page is short, then only
    // advance the watermark to the newest timestamp seen across all pages.
    while (true) {
      const page = await fetchGames({ username: user.username, max: pageSize, since, until });
      raw.push(...page);
      if (!since || page.length < pageSize) break;
      const timestamps = page.map((game) => game.createdAt).filter((value): value is number => Number.isFinite(value));
      if (timestamps.length !== page.length) throw new Error("Cannot safely paginate Lichess games without a createdAt timestamp on every game");
      const oldestTimestamp = Math.min(...timestamps);
      if (oldestTimestamp <= since || (until !== undefined && oldestTimestamp >= until)) break;
      until = oldestTimestamp;
    }
    const games = parseGames(raw, user.username);

    let insertedCount = 0;
    if (games.length > 0) {
      await prisma.$transaction(async (tx) => {
        const inserted = await tx.game.createMany({
          data: games.map((game) => ({
            lichessGameId: game.id,
            userId: user.id,
            playerColor: game.playerColor,
            opponentUsername: game.opponentUsername,
            opponentRating: game.opponentRating,
            playerRating: game.playerRating,
            moves: game.moves,
            clocks: game.clocks ?? undefined,
            clockInitialSec: game.clockInitialSec ?? null,
            clockIncrementSec: game.clockIncrementSec ?? null,
            openingName: game.openingName,
            openingEco: game.openingEco,
            result: game.result,
            rated: game.rated,
            speed: game.speed,
            lichessCreatedAt: game.createdAt ? new Date(game.createdAt) : null,
          })),
          skipDuplicates: true,
        });
        insertedCount = inserted.count;

        const eligibleIds = games.filter(isVanityEvaluationEligible).map((game) => game.id);
        if (eligibleIds.length > 0) {
          const storedEligible = await tx.game.findMany({
            where: { userId: user.id, lichessGameId: { in: eligibleIds } },
            select: { id: true },
          });
          if (storedEligible.length > 0) {
            await tx.vanityEvaluationJob.createMany({
              data: storedEligible.map((game) => ({ userId: user.id, gameId: game.id })),
              skipDuplicates: true,
            });
          }
        }
      });
    }

    const newestTimestamp = games.reduce(
      (newest, game) => (game.createdAt && game.createdAt > newest ? game.createdAt : newest),
      since ?? 0
    );
    const lastSyncedAt = new Date();
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastSyncedAt,
        lastGameCreatedAt: newestTimestamp ? new Date(newestTimestamp) : undefined,
      },
      select: { lastGameCreatedAt: true },
    });
    const totalGames = await prisma.game.count({ where: { userId: user.id } });

    return {
      ok: true,
      synced: insertedCount,
      totalGames,
      lastSyncedAt,
      lastGameCreatedAt: updatedUser.lastGameCreatedAt,
      skipped: false,
    };
  } catch (err) {
    console.error("Game sync failed:", err);
    return { ok: false, error: "sync failed" };
  }
}
