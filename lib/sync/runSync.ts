import { prisma } from "@/lib/prisma";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";

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
    const raw = await fetchGames({
      username: user.username,
      max: since ? 200 : 25,
      rated: true,
      perfType: "rapid",
      since,
    });
    const games = parseGames(raw, user.username);

    if (games.length > 0) {
      await prisma.$transaction(
        games.map((game) =>
          prisma.game.upsert({
            where: { id: game.id },
            update: {},
            create: {
              id: game.id,
              userId: user.id,
              playerColor: game.playerColor,
              opponentUsername: game.opponentUsername,
              opponentRating: game.opponentRating,
              playerRating: game.playerRating,
              moves: game.moves,
              clocks: game.clocks ?? undefined,
              openingName: game.openingName,
              openingEco: game.openingEco,
              result: game.result,
              rated: game.rated,
              speed: game.speed,
              lichessCreatedAt: game.createdAt ? new Date(game.createdAt) : null,
            },
          })
        )
      );
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
      synced: games.length,
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
