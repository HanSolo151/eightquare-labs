import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { updateWeaknessProfile } from "@/lib/profile/weaknessProfile";
import { updateBiasProfile, type BiasProfileState } from "@/lib/bias/updateBiasProfile";
import type { GameEval, MoveFeature, WeaknessProfile, FlaggedMove, PlayerProfile } from "@/types";

interface PushBody {
  gameId: string;
  gameEval: GameEval;
  moveFeatures: MoveFeature[];
  flags: FlaggedMove[];
  playerProfile: PlayerProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSerializationConflict(error: unknown): boolean {
  return isRecord(error) && error.code === "P2034";
}

function pushBodyValidationError(value: unknown): string | null {
  if (!isRecord(value)) return "body must be a JSON object";
  if (typeof value.gameId !== "string" || !value.gameId) return "gameId must be a non-empty string";
  if (!isRecord(value.gameEval)) return "gameEval must be an object";
  if (value.gameEval.gameId !== value.gameId) return "gameEval.gameId must match gameId";
  if (typeof value.gameEval.engineVersion !== "string") return "gameEval.engineVersion must be a string";
  if (!Array.isArray(value.gameEval.points)) return "gameEval.points must be an array";
  if (!Array.isArray(value.moveFeatures)) return "moveFeatures must be an array";
  if (!Array.isArray(value.flags)) return "flags must be an array";
  if (!isRecord(value.playerProfile)) return "playerProfile must be an object";

  const profile = value.playerProfile;
  if (typeof profile.username !== "string") return "playerProfile.username must be a string";
  if (!Number.isInteger(profile.gamesAnalyzed)) return "playerProfile.gamesAnalyzed must be an integer";
  if (!isFiniteNumber(profile.premoveRate)) return "playerProfile.premoveRate must be finite";
  if (!isRecord(profile.avgMoveTimeSecByPhase)) return "playerProfile.avgMoveTimeSecByPhase must be an object";
  if (!Array.isArray(profile.mostCommonOpenings)) return "playerProfile.mostCommonOpenings must be an array";
  if (!(profile.avgOpponentRating === null || isFiniteNumber(profile.avgOpponentRating))) {
    return "playerProfile.avgOpponentRating must be finite or null";
  }

  const gameEvalPoints = value.gameEval.points;
  for (let ply = 0; ply < gameEvalPoints.length; ply++) {
    const point = gameEvalPoints[ply];
    if (!isRecord(point)) return `gameEval.points[${ply}] must be an object`;
    const validScore = (score: unknown) => score === null || isFiniteNumber(score);
    if (point.ply !== ply) return `gameEval.points[${ply}].ply must equal its array index`;
    if (!validScore(point.cpBefore) || !validScore(point.cpAfter) ||
        !validScore(point.mateBefore) || !validScore(point.mateAfter)) {
      return `gameEval.points[${ply}] has a score that is neither finite nor null`;
    }
    if (!isFiniteNumber(point.depth)) return `gameEval.points[${ply}].depth must be finite`;
  }

  for (let index = 0; index < value.moveFeatures.length; index++) {
    const feature = value.moveFeatures[index];
    if (!isRecord(feature)) return `moveFeatures[${index}] must be an object`;
    if (feature.gameId !== value.gameId) return `moveFeatures[${index}].gameId must match gameId`;
    if (!Number.isInteger(feature.ply)) return `moveFeatures[${index}].ply must be an integer`;
  }

  const numericFlagFields = ["cpLoss", "timeSpentSec", "phaseAvgSec", "timeRatio", "ratio", "clockRemainingSec"] as const;
  for (let index = 0; index < value.flags.length; index++) {
    const flag = value.flags[index];
    if (!isRecord(flag)) return `flags[${index}] must be an object`;
    if (flag.gameId !== value.gameId) return `flags[${index}].gameId must match gameId`;
    if (!Number.isInteger(flag.ply)) return `flags[${index}].ply must be an integer`;
    for (const field of numericFlagFields) {
      if (!isFiniteNumber(flag[field])) return `flags[${index}].${field} must be finite`;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const payloadError = pushBodyValidationError(payload);
  if (payloadError) {
    return NextResponse.json(
      { error: "invalid evaluation payload", detail: payloadError },
      { status: 400 }
    );
  }
  const body = payload as PushBody;
  const { gameId, gameEval, moveFeatures, flags, playerProfile } = body;
  // The profile type represents an average and can legitimately be
  // fractional; the PostgreSQL column is Int, so normalize at persistence.
  const storedAvgOpponentRating = playerProfile.avgOpponentRating === null
    ? null
    : Math.round(playerProfile.avgOpponentRating);

  const game = await prisma.game.findUnique({
    where: { userId_lichessGameId: { userId, lichessGameId: gameId } },
  });
  if (!game) {
    return NextResponse.json({ error: "game not found" }, { status: 404 });
  }
  const storedMoves = Array.isArray(game.moves) ? game.moves : null;
  if (!storedMoves || gameEval.points.length !== storedMoves.length) {
    return NextResponse.json({ error: "evaluation does not match the stored game" }, { status: 400 });
  }
  if (
    moveFeatures.some((feature) => feature.ply < 0 || feature.ply >= storedMoves.length) ||
    flags.some((flag) => flag.ply < 0 || flag.ply >= storedMoves.length)
  ) {
    return NextResponse.json({ error: "move data contains a ply outside the stored game" }, { status: 400 });
  }

  let transactionAttempt = 0;
  while (true) {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.gameEval.upsert({
      where: { gameId: game.id },
      update: {
        points: gameEval.points as unknown as Prisma.InputJsonValue,
        engineVersion: gameEval.engineVersion,
      },
      create: {
        gameId: game.id,
        points: gameEval.points as unknown as Prisma.InputJsonValue,
        engineVersion: gameEval.engineVersion,
      },
    });

    await tx.flaggedMove.deleteMany({ where: { gameId: game.id } });
    if (flags.length > 0) {
      await tx.flaggedMove.createMany({
        data: flags.map((f) => ({
          gameId: game.id,
          ply: f.ply,
          moveNumber: f.moveNumber,
          san: f.san,
          color: f.color,
          flagType: f.flagType,
          timeSpentSec: f.timeSpentSec,
          phaseAvgSec: f.phaseAvgSec,
          timeRatio: f.timeRatio,
          ratio: f.ratio,
          clockRemainingSec: f.clockRemainingSec,
          gamePhase: f.gamePhase,
          cpLoss: f.cpLoss,
          causality: f.causality as unknown as Prisma.InputJsonValue,
          matchedWeaknessId: f.matchedWeaknessId,
          styleDeviationScore: f.styleDeviationScore,
          absoluteAnomalyScore: f.absoluteAnomalyScore,
          severity: f.severity,
          severityBreakdown: f.severityBreakdown as unknown as Prisma.InputJsonValue,
          pivotMove: f.pivotMove
            ? (f.pivotMove as unknown as Prisma.InputJsonValue)
            : undefined,
          cascadeMeta: f.cascadeMeta
            ? (f.cascadeMeta as unknown as Prisma.InputJsonValue)
            : undefined,
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
        patterns: updated.patterns as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: updated.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        gamesEvaluated: updated.gamesEvaluated,
        gamesFetched: updated.gamesFetched,
        confidence: updated.confidence,
      },
      create: {
        userId,
        patterns: updated.patterns as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: updated.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        gamesEvaluated: updated.gamesEvaluated,
        gamesFetched: updated.gamesFetched,
        confidence: updated.confidence,
      },
    });

    const biasRow = await tx.biasProfile.findUnique({ where: { userId } });
    const storedBiasGameIds = Array.isArray(biasRow?.evaluatedGameIds)
      ? biasRow.evaluatedGameIds.filter((id): id is string => typeof id === "string")
      : [];
    const existingBias: BiasProfileState = biasRow
      ? {
          squareBias: biasRow.squareBias as unknown as BiasProfileState["squareBias"],
          evaluatedGameIds: storedBiasGameIds,
          sampleSize: biasRow.sampleSize,
          confidence: biasRow.confidence as BiasProfileState["confidence"],
          builtAt: biasRow.builtAt.getTime(),
        }
      : { squareBias: {}, evaluatedGameIds: [], sampleSize: 0, confidence: "low", builtAt: Date.now() };

    const updatedBias = updateBiasProfile(
      existingBias,
      gameId,
      storedMoves as string[],
      moveFeatures,
      flags,
      game.playerColor as "white" | "black"
    );

    await tx.biasProfile.upsert({
      where: { userId },
      update: {
        squareBias: updatedBias.squareBias as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: updatedBias.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        sampleSize: updatedBias.sampleSize,
        confidence: updatedBias.confidence,
        builtAt: new Date(updatedBias.builtAt),
      },
      create: {
        userId,
        // Legacy rank/file/diagonal columns default to empty JSON; supported
        // aggregates are derived from squareBias when the profile is read.
        squareBias: updatedBias.squareBias as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: updatedBias.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        sampleSize: updatedBias.sampleSize,
        confidence: updatedBias.confidence,
        builtAt: new Date(updatedBias.builtAt),
      },
    });

    await tx.playerProfile.upsert({
      where: { userId },
      update: {
        gamesAnalyzed: playerProfile.gamesAnalyzed,
        avgMoveTimeSecByPhase: playerProfile.avgMoveTimeSecByPhase as unknown as Prisma.InputJsonValue,
        premoveRate: playerProfile.premoveRate,
        mostCommonOpenings: playerProfile.mostCommonOpenings as unknown as Prisma.InputJsonValue,
        avgOpponentRating: storedAvgOpponentRating,
      },
      create: {
        userId,
        gamesAnalyzed: playerProfile.gamesAnalyzed,
        avgMoveTimeSecByPhase: playerProfile.avgMoveTimeSecByPhase as unknown as Prisma.InputJsonValue,
        premoveRate: playerProfile.premoveRate,
        mostCommonOpenings: playerProfile.mostCommonOpenings as unknown as Prisma.InputJsonValue,
        avgOpponentRating: storedAvgOpponentRating,
      },
    });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (err) {
      // Two devices can finish evaluations for the same user concurrently.
      // The weakness-profile update is read/modify/write, so serialize it in
      // Postgres and retry serialization failures instead of losing one update.
      if (!isSerializationConflict(err)) throw err;
      if (transactionAttempt >= 2) {
        console.error("Evaluation persistence hit repeated transaction conflicts:", err);
        return NextResponse.json(
          { error: "evaluation persistence is busy; retry shortly" },
          { status: 503, headers: { "Retry-After": "1" } }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** transactionAttempt)));
      transactionAttempt++;
    }
  }

  return NextResponse.json({ ok: true });
}
