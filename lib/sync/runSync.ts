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
      historyBackfillComplete: boolean;
      skipped: boolean;
    }
  | { ok: false; error: string };

// Passive page loads are throttled so repeated dashboard visits don't
// repeatedly call Lichess. Explicit sync requests can bypass this interval.
const MIN_SYNC_INTERVAL_MS = 60 * 1000;
const SYNC_PAGE_SIZE = 200;
const HISTORY_BACKFILL_BATCH_SIZE = 100;
const USER_HISTORY_TARGET = 500;

async function fetchGamePages(opts: {
  username: string;
  maxGames: number | null;
  since?: number;
  until?: number;
}) {
  const games: Awaited<ReturnType<typeof fetchGames>> = [];
  let until = opts.until;
  while (opts.maxGames === null || games.length < opts.maxGames) {
    const remaining = opts.maxGames === null ? SYNC_PAGE_SIZE : opts.maxGames - games.length;
    const pageSize = Math.min(SYNC_PAGE_SIZE, remaining);
    if (pageSize <= 0) break;
    const page = await fetchGames({ username: opts.username, max: pageSize, since: opts.since, until });
    games.push(...page);
    if (page.length < pageSize) break;

    const timestamps = page.map((game) => game.createdAt).filter((value): value is number => Number.isFinite(value));
    if (timestamps.length !== page.length) throw new Error("Cannot safely paginate Lichess games without a createdAt timestamp on every game");
    const oldestTimestamp = Math.min(...timestamps);
    if ((opts.since !== undefined && oldestTimestamp <= opts.since) || (until !== undefined && oldestTimestamp >= until)) break;
    until = oldestTimestamp - 1;
  }
  return games;
}

/**
 * Incremental Lichess -> Game table sync for one user.
 * Called by POST /api/sync; the client chains short requests during backfill.
 */
export async function runSync(
  userId: string,
  opts: { force?: boolean; skipIncremental?: boolean } = {}
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
          historyBackfillComplete: user.historyBackfillComplete,
          skipped: true,
        };
      }
    }

    const since = user.lastGameCreatedAt?.getTime();
    const raw: Awaited<ReturnType<typeof fetchGames>> = [];
    const existingGameCount = await prisma.game.count({ where: { userId: user.id } });
    let backfillComplete = user.historyBackfillComplete;

    // Catch up on new games first. Historical imports are limited to one
    // 100-game batch per request so the UI can show progress between batches.
    if (since !== undefined && !opts.skipIncremental) {
      raw.push(...await fetchGamePages({ username: user.username, maxGames: null, since }));
    }

    if (!backfillComplete) {
      const remainingHistory = Math.max(0, USER_HISTORY_TARGET - existingGameCount - raw.length);
      if (remainingHistory === 0) {
        backfillComplete = true;
      } else {
        const batchSize = Math.min(HISTORY_BACKFILL_BATCH_SIZE, remainingHistory);
        const oldestStoredGame = existingGameCount > 0 ? await prisma.game.findFirst({
          where: { userId: user.id, lichessCreatedAt: { not: null } },
          orderBy: { lichessCreatedAt: "asc" },
          select: { lichessCreatedAt: true },
        }) : null;
        const until = oldestStoredGame?.lichessCreatedAt?.getTime();
        const history = await fetchGamePages({
          username: user.username,
          maxGames: batchSize,
          until: until === undefined ? undefined : until - 1,
        });
        raw.push(...history);
        backfillComplete = history.length < batchSize || existingGameCount + raw.length >= USER_HISTORY_TARGET;
      }
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
        historyBackfillComplete: backfillComplete,
      },
      select: { lastGameCreatedAt: true },
    });
    const totalGames = await prisma.game.count({ where: { userId: user.id } });

    if (insertedCount === 0 && !backfillComplete) {
      // Avoid retrying the same unparseable/duplicate page forever.
      backfillComplete = true;
      await prisma.user.update({ where: { id: user.id }, data: { historyBackfillComplete: true } });
    }

    return {
      ok: true,
      synced: insertedCount,
      totalGames,
      lastSyncedAt,
      lastGameCreatedAt: updatedUser.lastGameCreatedAt,
      historyBackfillComplete: backfillComplete,
      skipped: false,
    };
  } catch (err) {
    console.error("Game sync failed:", err);
    return { ok: false, error: "sync failed" };
  }
}
