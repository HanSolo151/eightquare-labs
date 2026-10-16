import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { updateWeaknessProfile } from "@/lib/profile/weaknessProfile";
import type { GameEval, MoveFeature, WeaknessProfile, FlaggedMove } from "@/types";

interface PushBody {
  gameId: string;
  gameEval: GameEval;
  moveFeatures: MoveFeature[];
  flags: FlaggedMove[];
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as PushBody;
  const { gameId, gameEval, moveFeatures, flags } = body;

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.userId !== userId) {
    return NextResponse.json({ error: "game not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.gameEval.upsert({
      where: { gameId },
      update: { points: gameEval.points, engineVersion: gameEval.engineVersion },
      create: {
        gameId,
        points: gameEval.points,
        engineVersion: gameEval.engineVersion,
      },
    });

    await tx.flaggedMove.deleteMany({ where: { gameId } });
    if (flags.length > 0) {
      await tx.flaggedMove.createMany({
        data: flags.map((f) => ({
          gameId,
          ply: f.ply,
          moveNumber: f.moveNumber,
          san: f.san,
          color: f.color,
          flagType: f.flagType,
          timeSpentSec: f.timeSpentSec,
          phaseAvgSec: f.phaseAvgSec,
          timeRatio: f.timeRatio,
          clockRemainingSec: f.clockRemainingSec,
          gamePhase: f.gamePhase,
          cpLoss: f.cpLoss,
          causality: f.causality,
          matchedWeaknessId: f.matchedWeaknessId,
          styleDeviationScore: f.styleDeviationScore,
          absoluteAnomalyScore: f.absoluteAnomalyScore,
          severity: f.severity,
          severityBreakdown: f.severityBreakdown,
          pivotMove: f.pivotMove ?? undefined,
          cascadeMeta: f.cascadeMeta ?? undefined,
          evalConfidence: f.evalConfidence,
          explanation: f.explanation,
        })),
      });
    }

    const row = await tx.weaknessProfileRow.findUnique({ where: { userId } });
    const existing: WeaknessProfile = row
      ? {
          username: session!.user!.name ?? "",
          patterns: row.patterns as unknown as WeaknessProfile["patterns"],
          evaluatedGameIds: row.evaluatedGameIds as unknown as string[],
          gamesEvaluated: row.gamesEvaluated,
          gamesFetched: row.gamesFetched,
          confidence: row.confidence as WeaknessProfile["confidence"],
          builtAt: row.builtAt.getTime(),
        }
      : {
          username: session!.user!.name ?? "",
          patterns: [],
          evaluatedGameIds: [],
          gamesEvaluated: 0,
          gamesFetched: 0,
          confidence: "low",
          builtAt: Date.now(),
        };

    const updated = updateWeaknessProfile(
      existing,
      gameId,
      gameEval,
      moveFeatures,
      game.playerColor as "white" | "black"
    );

    await tx.weaknessProfileRow.upsert({
      where: { userId },
      update: {
        patterns: updated.patterns,
        evaluatedGameIds: updated.evaluatedGameIds,
        gamesEvaluated: updated.gamesEvaluated,
        gamesFetched: updated.gamesFetched,
        confidence: updated.confidence,
      },
      create: {
        userId,
        patterns: updated.patterns,
        evaluatedGameIds: updated.evaluatedGameIds,
        gamesEvaluated: updated.gamesEvaluated,
        gamesFetched: updated.gamesFetched,
        confidence: updated.confidence,
      },
    });
  });

  return NextResponse.json({ ok: true });
}
