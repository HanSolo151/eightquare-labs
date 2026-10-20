import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

const RESOLVING_OUTCOMES = new Set(["win", "draw"]);

export async function POST(request: NextRequest) {
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    gameId?: unknown;
    ply?: unknown;
    outcome?: unknown;
  } | null;
  if (
    typeof body?.gameId !== "string" || !body.gameId.trim() || body.gameId.length > 128 ||
    typeof body.ply !== "number" || !Number.isSafeInteger(body.ply) || body.ply < 0 ||
    typeof body.outcome !== "string" || !RESOLVING_OUTCOMES.has(body.outcome)
  ) {
    return NextResponse.json({ error: "valid gameId, non-negative ply, and win/draw outcome are required" }, { status: 400 });
  }

  const gameId = body.gameId.trim();
  try {
    const resolved = await prisma.$transaction(async (tx) => {
      const flag = await tx.flaggedMove.findFirst({
        where: { gameId, ply: body.ply as number, game: { userId } },
        select: { id: true },
      });
      if (!flag) return null;

      const created = await tx.resolvedSparPosition.createMany({
        data: [{ userId, gameId, ply: body.ply as number }],
        skipDuplicates: true,
      });
      return { found: true, newlyResolved: created.count > 0 };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (!resolved) return NextResponse.json({ error: "flagged position not found" }, { status: 404 });
    return NextResponse.json({ ok: true, newlyResolved: resolved.newlyResolved });
  } catch (error) {
    console.error("Spar position resolution failed:", error);
    return NextResponse.json({ error: "could not save resolved position" }, { status: 500 });
  }
}
