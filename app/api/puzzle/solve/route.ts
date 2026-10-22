import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { gameId?: unknown; ply?: unknown } | null;
  if (typeof body?.gameId !== "string" || !body.gameId.trim() || body.gameId.length > 128 ||
      typeof body.ply !== "number" || !Number.isSafeInteger(body.ply) || body.ply < 0) {
    return NextResponse.json({ error: "valid gameId and non-negative integer ply are required" }, { status: 400 });
  }
  const gameId = body.gameId.trim();
  const solvedAt = new Date();
  try {
    const solved = await prisma.$transaction(async (tx) => {
      const flag = await tx.flaggedMove.findFirst({
        where: { gameId, ply: body.ply as number, game: { userId } },
        select: { id: true },
      });
      if (!flag) return false;

      await tx.dailyPuzzleState.upsert({
        where: { userId_gameId_ply: { userId, gameId, ply: body.ply as number } },
        update: { status: "solved", solvedAt },
        create: { userId, gameId, ply: body.ply as number, status: "solved", solvedAt },
      });
      await tx.resolvedSparPosition.createMany({
        data: [{ userId, gameId, ply: body.ply as number, resolvedAt: solvedAt }],
        skipDuplicates: true,
      });
      return true;
    });
    if (!solved) return NextResponse.json({ error: "puzzle not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Daily puzzle solve failed:", error);
    const missingTable = typeof error === "object" && error !== null && "code" in error && error.code === "P2021";
    return NextResponse.json(
      { error: missingTable ? "puzzle tracking is unavailable until the database migrations are applied" : "could not save puzzle solve" },
      { status: missingTable ? 503 : 500 }
    );
  }
}
