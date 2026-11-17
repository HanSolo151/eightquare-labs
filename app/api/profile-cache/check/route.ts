import { connection, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fetchGames, LichessFetchError } from "@/lib/lichess/fetchGames";

const NEW_GAME_CHECK_LIMIT = 100;

export async function GET() {
  await connection();
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, lastGameCreatedAt: true },
    });
    if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

    const games = await fetchGames({
      username: user.username,
      max: NEW_GAME_CHECK_LIMIT,
      since: user.lastGameCreatedAt?.getTime(),
    });
    const lastGameTimestamp = user.lastGameCreatedAt?.getTime() ?? null;
    const newGamesCount = games.filter((game) =>
      typeof game.createdAt === "number" &&
      Number.isFinite(game.createdAt) &&
      (lastGameTimestamp === null || game.createdAt > lastGameTimestamp),
    ).length;

    return NextResponse.json({
      userId,
      newGamesCount,
      capped: newGamesCount === NEW_GAME_CHECK_LIMIT,
      lastGameTimestamp,
    });
  } catch (error) {
    console.error("New Lichess games check failed:", error);
    if (error instanceof LichessFetchError && error.isCloudflareChallenge) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ error: "new games check unavailable" }, { status: 502 });
  }
}
