import { Prisma } from "@prisma/client";
import { MATCHING_CONFIG } from "@/config/matching";
import { buildPlayerProfile, extractAllMoveFeatures } from "@/lib/features/extractFeatures";
import { flagMoves } from "@/lib/flags/flagEngine";
import { evaluateServerGame, type ServerEvalCheckpoint } from "@/lib/eval/evaluateServerGame";
import { StockfishCli } from "@/lib/eval/stockfishCli";
import { updateWeaknessProfile } from "@/lib/profile/weaknessProfile";
import { isVanityEvaluationEligible } from "./vanityEligibility";
import { prisma } from "@/lib/prisma";
import type { EvalPoint, FlaggedMove, GameEval, ParsedGame, WeaknessProfile } from "@/types";

const EVAL_DEPTH = MATCHING_CONFIG.INGEST_EVAL_DEPTH;
const LEASE_MS = MATCHING_CONFIG.VANITY_EVAL_JOB_LEASE_MINUTES * 60 * 1000;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? value : null;
}

function toParsedGame(game: {
  id: string; playerColor: string; opponentUsername: string; opponentRating: number | null; playerRating: number | null;
  moves: unknown; clocks: unknown; clockInitialSec: number | null; clockIncrementSec: number | null; openingName: string | null;
  openingEco: string | null; result: string; rated: boolean; speed: string | null; lichessCreatedAt: Date | null;
}): ParsedGame {
  const playerColor = game.playerColor === "black" ? "black" : "white";
  const result = game.result === "win" || game.result === "loss" ? game.result : "draw";
  return {
    id: game.id,
    playerColor,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    moves: stringArray(game.moves),
    clocks: numberArray(game.clocks),
    clockInitialSec: game.clockInitialSec,
    clockIncrementSec: game.clockIncrementSec,
    openingName: game.openingName,
    openingEco: game.openingEco,
    result,
    rated: game.rated,
    speed: game.speed,
    createdAt: game.lichessCreatedAt?.getTime() ?? null,
  };
}

function readCheckpoint(value: unknown): ServerEvalCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as { points?: unknown; evalBefore?: unknown };
  if (!Array.isArray(row.points) || !row.evalBefore || typeof row.evalBefore !== "object") return undefined;
  const points = row.points.filter((point): point is EvalPoint => {
    if (!point || typeof point !== "object") return false;
    const candidate = point as Partial<EvalPoint>;
    return Number.isInteger(candidate.ply) && typeof candidate.depth === "number";
  });
  const evalBefore = row.evalBefore as ServerEvalCheckpoint["evalBefore"];
  if (![evalBefore.cp, evalBefore.mate, evalBefore.depth].every((value) => value === null || typeof value === "number")) return undefined;
  return { points, evalBefore };
}

function emptyWeaknessProfile(username: string): WeaknessProfile {
  return { username, patterns: [], evaluatedGameIds: [], gamesEvaluated: 0, gamesFetched: 0, confidence: "low", builtAt: Date.now() };
}

function weaknessProfileFromRow(row: { patterns: unknown; evaluatedGameIds: unknown; gamesEvaluated: number; gamesFetched: number; confidence: string; builtAt: Date } | null, username: string): WeaknessProfile {
  if (!row) return emptyWeaknessProfile(username);
  return {
    username,
    patterns: Array.isArray(row.patterns) ? row.patterns as WeaknessProfile["patterns"] : [],
    evaluatedGameIds: stringArray(row.evaluatedGameIds),
    gamesEvaluated: row.gamesEvaluated,
    gamesFetched: row.gamesFetched,
    confidence: row.confidence === "high" || row.confidence === "medium" ? row.confidence : "low",
    builtAt: row.builtAt.getTime(),
  };
}

async function claimNextJob(now: Date): Promise<string | null> {
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "VanityEvaluationJob"
    SET "status" = 'processing', "attempts" = "attempts" + 1, "lockedAt" = ${now}, "updatedAt" = ${now}
    WHERE "id" = (
      SELECT "id" FROM "VanityEvaluationJob"
      WHERE ("status" = 'queued' AND "availableAt" <= ${now})
         OR ("status" = 'processing' AND "lockedAt" < ${staleBefore})
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id"
  `;
  return claimed[0]?.id ?? null;
}

export interface VanityQueueRunResult {
  claimed: boolean;
  completed: boolean;
}

export async function processNextVanityEvaluation(now = new Date()): Promise<VanityQueueRunResult> {
  const jobId = await claimNextJob(now);
  if (!jobId) return { claimed: false, completed: false };
  const job = await prisma.vanityEvaluationJob.findUnique({
    where: { id: jobId },
    include: { game: { include: { eval: true } }, user: { select: { username: true } } },
  });
  if (!job) return { claimed: true, completed: false };

  if (!job.game.rated || !isVanityEvaluationEligible({ rated: job.game.rated, result: job.game.result as ParsedGame["result"], speed: job.game.speed })) {
    await prisma.vanityEvaluationJob.update({ where: { id: job.id }, data: { status: "complete", lockedAt: null, checkpoint: Prisma.DbNull, lastError: null } });
    return { claimed: true, completed: true };
  }

  let engine: StockfishCli | null = null;
  try {
    const game = toParsedGame(job.game);
    let gameEval: GameEval;
    let flags: FlaggedMove[];
    if (job.game.eval) {
      gameEval = {
        gameId: job.game.id,
        points: Array.isArray(job.game.eval.points) ? job.game.eval.points as unknown as EvalPoint[] : [],
        evaluatedAt: job.game.eval.evaluatedAt.getTime(),
        engineVersion: job.game.eval.engineVersion,
      };
      const storedFlags = await prisma.flaggedMove.findMany({ where: { gameId: job.game.id } });
      flags = storedFlags as unknown as FlaggedMove[];
    } else {
      const checkpoint = readCheckpoint(job.checkpoint);
      engine = await StockfishCli.create();
      gameEval = await evaluateServerGame(
        game.id,
        game.moves,
        (fen) => engine!.evaluate(fen, EVAL_DEPTH),
        checkpoint,
        async (progress) => {
          if (progress.points.length % MATCHING_CONFIG.VANITY_EVAL_JOB_CHECKPOINT_PLIES === 0) {
            await prisma.vanityEvaluationJob.update({
              where: { id: job.id },
              data: { checkpoint: progress as unknown as Prisma.InputJsonValue, lockedAt: new Date() },
            });
          }
        },
      );
      const userGamesRows = await prisma.game.findMany({
        where: { userId: job.userId },
        select: {
          id: true, playerColor: true, opponentUsername: true, opponentRating: true, playerRating: true, moves: true,
          clocks: true, clockInitialSec: true, clockIncrementSec: true, openingName: true, openingEco: true, result: true,
          rated: true, speed: true, lichessCreatedAt: true,
        },
      });
      const userGames = userGamesRows.map(toParsedGame);
      const features = extractAllMoveFeatures(userGames);
      const playerProfile = buildPlayerProfile(job.user.username, userGames, features);
      const weaknessRow = await prisma.weaknessProfileRow.findUnique({ where: { userId: job.userId } });
      const weaknessProfile = weaknessProfileFromRow(weaknessRow, job.user.username);
      const gameFeatures = features.filter((feature) => feature.gameId === game.id);
      flags = flagMoves(gameFeatures, playerProfile, weaknessProfile, gameEval, game.playerColor);
      updateWeaknessProfile(weaknessProfile, game.id, gameEval, gameFeatures, game.playerColor);

      await prisma.$transaction(async (tx) => {
        await tx.gameEval.upsert({
          where: { gameId: game.id },
          create: { gameId: game.id, points: gameEval.points as unknown as Prisma.InputJsonValue, engineVersion: gameEval.engineVersion },
          update: { points: gameEval.points as unknown as Prisma.InputJsonValue, engineVersion: gameEval.engineVersion },
        });
        await tx.flaggedMove.deleteMany({ where: { gameId: game.id } });
        if (flags.length > 0) {
          await tx.flaggedMove.createMany({
            data: flags.map((flag) => ({
              gameId: game.id,
              ply: flag.ply,
              moveNumber: flag.moveNumber,
              san: flag.san,
              color: flag.color,
              flagType: flag.flagType,
              timeSpentSec: flag.timeSpentSec,
              phaseAvgSec: flag.phaseAvgSec,
              timeRatio: flag.timeRatio,
              ratio: flag.ratio,
              clockRemainingSec: flag.clockRemainingSec,
              gamePhase: flag.gamePhase,
              cpLoss: flag.cpLoss,
              causality: flag.causality as unknown as Prisma.InputJsonValue,
              matchedWeaknessId: flag.matchedWeaknessId,
              styleDeviationScore: flag.styleDeviationScore,
              absoluteAnomalyScore: flag.absoluteAnomalyScore,
              severity: flag.severity,
              severityBreakdown: flag.severityBreakdown as unknown as Prisma.InputJsonValue,
              pivotMove: flag.pivotMove ? flag.pivotMove as unknown as Prisma.InputJsonValue : undefined,
              cascadeMeta: flag.cascadeMeta ? flag.cascadeMeta as unknown as Prisma.InputJsonValue : undefined,
              evalConfidence: flag.evalConfidence,
              explanation: flag.explanation,
            })),
          });
        }
        await tx.weaknessProfileRow.upsert({
          where: { userId: job.userId },
          create: {
            userId: job.userId,
            patterns: weaknessProfile.patterns as unknown as Prisma.InputJsonValue,
            evaluatedGameIds: weaknessProfile.evaluatedGameIds as unknown as Prisma.InputJsonValue,
            gamesEvaluated: weaknessProfile.gamesEvaluated,
            gamesFetched: weaknessProfile.gamesFetched,
            confidence: weaknessProfile.confidence,
          },
          update: {
            patterns: weaknessProfile.patterns as unknown as Prisma.InputJsonValue,
            evaluatedGameIds: weaknessProfile.evaluatedGameIds as unknown as Prisma.InputJsonValue,
            gamesEvaluated: weaknessProfile.gamesEvaluated,
            gamesFetched: weaknessProfile.gamesFetched,
            confidence: weaknessProfile.confidence,
          },
        });
      });
    }

    await prisma.vanityEvaluationJob.update({
      where: { id: job.id },
      data: { status: "complete", lockedAt: null, checkpoint: Prisma.DbNull, lastError: null },
    });
    return { claimed: true, completed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown evaluation failure";
    const exhausted = job.attempts >= MATCHING_CONFIG.VANITY_EVAL_JOB_MAX_ATTEMPTS;
    const backoffMinutes = Math.min(
      MATCHING_CONFIG.VANITY_EVAL_JOB_RETRY_MAX_MINUTES,
      MATCHING_CONFIG.VANITY_EVAL_JOB_RETRY_BASE_MINUTES * 2 ** Math.max(0, job.attempts - 1),
    );
    await prisma.vanityEvaluationJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? "failed" : "queued",
        lockedAt: null,
        availableAt: new Date(now.getTime() + backoffMinutes * 60 * 1000),
        lastError: message.slice(0, 2_000),
      },
    });
    console.error("Vanity evaluation job failed", { jobId: job.id, attempts: job.attempts, exhausted, error });
    return { claimed: true, completed: false };
  } finally {
    engine?.close();
  }
}
