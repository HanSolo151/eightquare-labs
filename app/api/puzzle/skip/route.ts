import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { SKIP_RETIRE_THRESHOLD } from "@/lib/puzzle/getDailyPuzzle";

export async function POST(request: NextRequest) {
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { gameId?: unknown; ply?: unknown } | null;
  if (typeof body?.gameId !== "string" || !body.gameId.trim() || body.gameId.length > 128 ||
      typeof body.ply !== "number" || !Number.isSafeInteger(body.ply) || body.ply < 0) {
    return NextResponse.json({ error: "valid gameId and non-negative integer ply are required" }, { status: 400 });
  }
  const gameId = body.gameId.trim();
  try {
    const status = await prisma.$transaction(async (tx) => {
      const flag = await tx.flaggedMove.findFirst({
        where: { gameId, ply: body.ply as number, game: { userId } },
        select: { id: true },
      });
      if (!flag) return null;
      const existing = await tx.dailyPuzzleState.findUnique({
        where: { userId_gameId_ply: { userId, gameId, ply: body.ply as number } },
      });
      if (existing?.status === "solved" || existing?.status === "deferred") return existing.status;
      const skipCount = (existing?.skipCount ?? 0) + 1;
      const nextStatus = skipCount >= SKIP_RETIRE_THRESHOLD ? "deferred" : "active";
      await tx.dailyPuzzleState.upsert({
        where: { userId_gameId_ply: { userId, gameId, ply: body.ply as number } },
        update: { skipCount, status: nextStatus, lastSkippedAt: new Date() },
        create: { userId, gameId, ply: body.ply as number, skipCount, status: nextStatus, lastSkippedAt: new Date() },
      });
      return nextStatus;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!status) return NextResponse.json({ error: "puzzle not found" }, { status: 404 });
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.error("Daily puzzle skip failed:", error);
    return NextResponse.json({ error: "could not save puzzle skip" }, { status: 500 });
  }
}
