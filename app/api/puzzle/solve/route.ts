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
  const flag = await prisma.flaggedMove.findFirst({
    where: { gameId, ply: body.ply, game: { userId } },
    select: { id: true },
  });
  if (!flag) return NextResponse.json({ error: "puzzle not found" }, { status: 404 });

  const solvedAt = new Date();
  await prisma.dailyPuzzleState.upsert({
    where: { userId_gameId_ply: { userId, gameId, ply: body.ply } },
    update: { status: "solved", solvedAt },
    create: { userId, gameId, ply: body.ply, status: "solved", solvedAt },
  });
  return NextResponse.json({ ok: true });
}
