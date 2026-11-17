import { connection, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

function startOfUtcWeek(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

export async function GET() {
  await connection();
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const weekStart = startOfUtcWeek(new Date());
  try {
    const [sparResolutions, solvedPuzzles, recentGames, totalGames, evaluatedGames] = await Promise.all([
      prisma.resolvedSparPosition.findMany({
        where: { userId },
        select: { gameId: true, ply: true, resolvedAt: true },
      }),
      prisma.dailyPuzzleState.findMany({
        where: { userId, status: "solved" },
        select: { gameId: true, ply: true, solvedAt: true },
      }),
      prisma.game.findMany({
        where: { userId },
        orderBy: [{ lichessCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: 5,
        select: { id: true, opponentUsername: true, result: true, openingName: true, lichessCreatedAt: true },
      }),
      prisma.game.count({ where: { userId } }),
      prisma.game.count({ where: { userId, eval: { isNot: null } } }),
    ]);

    const resolvedThisWeek = new Set<string>();
    for (const resolution of sparResolutions) {
      if (resolution.resolvedAt >= weekStart) resolvedThisWeek.add(`${resolution.gameId}:${resolution.ply}`);
    }

    const puzzleGameIds = [...new Set(solvedPuzzles.map((puzzle) => puzzle.gameId))];
    let puzzleGames: Array<{ id: string }> = [];
    let ownedPuzzleGameIds = new Set<string>();
    if (puzzleGameIds.length > 0) {
      puzzleGames = await prisma.game.findMany({
        where: { id: { in: puzzleGameIds }, userId },
        select: { id: true },
      });
      ownedPuzzleGameIds = new Set(puzzleGames.map((game) => game.id));
      for (const puzzle of solvedPuzzles) {
        if (ownedPuzzleGameIds.has(puzzle.gameId) && puzzle.solvedAt && puzzle.solvedAt >= weekStart) {
          resolvedThisWeek.add(`${puzzle.gameId}:${puzzle.ply}`);
        }
      }
    }

    const resolvedKeys = new Set<string>();
    for (const resolution of sparResolutions) {
      resolvedKeys.add(`${resolution.gameId}:${resolution.ply}`);
    }
    for (const puzzle of solvedPuzzles) {
      if (ownedPuzzleGameIds.has(puzzle.gameId)) resolvedKeys.add(`${puzzle.gameId}:${puzzle.ply}`);
    }

    return NextResponse.json({
      resolvedKeys: [...resolvedKeys],
      weeklyResolvedCount: resolvedThisWeek.size,
      totalGames,
      evaluatedGames,
      recentGames: recentGames.map((game) => ({
        gameId: game.id,
        opponentUsername: game.opponentUsername,
        result: game.result,
        openingName: game.openingName,
        playedAt: game.lichessCreatedAt?.getTime() ?? null,
      })),
    });
  } catch (error) {
    console.error("Profile home summary failed:", error);
    return NextResponse.json({ error: "home summary unavailable" }, { status: 500 });
  }
}
