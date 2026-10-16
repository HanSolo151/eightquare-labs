import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";

export async function POST() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const since = user.lastGameCreatedAt?.getTime();

  try {
    const raw = await fetchGames({
      username: user.username,
      max: since ? 200 : 25,
      rated: true,
      perfType: "rapid",
      since,
    });
    const games = parseGames(raw, user.username);

    if (games.length === 0) {
      return NextResponse.json({ synced: 0 });
    }

    await prisma.$transaction(
      games.map((g) =>
        prisma.game.upsert({
          where: { id: g.id },
          update: {},
          create: {
            id: g.id,
            userId: user.id,
            playerColor: g.playerColor,
            opponentUsername: g.opponentUsername,
            opponentRating: g.opponentRating,
            playerRating: g.playerRating,
            moves: g.moves,
            clocks: g.clocks ?? undefined,
            openingName: g.openingName,
            openingEco: g.openingEco,
            result: g.result,
            rated: g.rated,
            speed: g.speed,
            lichessCreatedAt: g.createdAt ? new Date(g.createdAt) : null,
          },
        })
      )
    );

    const newest = games.reduce(
      (max, g) => (g.createdAt && g.createdAt > max ? g.createdAt : max),
      since ?? 0
    );

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastSyncedAt: new Date(),
        lastGameCreatedAt: newest ? new Date(newest) : undefined,
      },
    });

    return NextResponse.json({ synced: games.length });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "sync failed" }, { status: 500 });
  }
}
