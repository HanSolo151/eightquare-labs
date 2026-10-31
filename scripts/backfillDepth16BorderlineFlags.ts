import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { EvalPoint, GameEval, ParsedGame, WeaknessProfile } from "../types";
import { buildPlayerProfile, extractAllMoveFeatures } from "../lib/features/extractFeatures";
import { flagMoves, resolveCpLoss } from "../lib/flags/flagEngine";
import { evaluateServerGame } from "../lib/eval/evaluateServerGame";
import { StockfishCli } from "../lib/eval/stockfishCli";

const ENGINE_VERSION = "stockfish-19-lite-single-depth16-target-v3";
const applyChanges = process.argv.includes("--apply");

type PersistedFlag = {
  id: string;
  ply: number;
  flagType: string;
  severity: string;
  cpLoss: number;
  cascadeMeta: unknown;
};

type FlagOutcome = "recovered" | "fellBelow100cp" | "noLongerEmitted";

type OutcomeCounts = {
  candidates: number;
  recovered: number;
  fellBelow100cp: number;
  noLongerEmitted: number;
  unreachable: number;
};

function isCascade(flag: PersistedFlag): boolean {
  return flag.flagType === "evaluation_cascade" || flag.flagType === "tilt_cascade";
}

function flagPlies(flag: PersistedFlag): number[] {
  if (!isCascade(flag)) return [flag.ply];
  const meta = typeof flag.cascadeMeta === "object" && flag.cascadeMeta !== null ? flag.cascadeMeta : {};
  const startPly = "startPly" in meta && typeof meta.startPly === "number" ? meta.startPly : flag.ply;
  const sequenceLength = "sequenceLength" in meta && typeof meta.sequenceLength === "number" ? meta.sequenceLength : 1;
  return Array.from({ length: Math.max(1, sequenceLength) }, (_, index) => startPly + 2 * index);
}

function outcomeForFlag(
  original: PersistedFlag,
  freshPoints: EvalPoint[],
  freshFlags: ReturnType<typeof flagMoves>,
): FlagOutcome {
  const emitted = freshFlags.some((flag) => {
    if (flag.flagType !== original.flagType) return false;
    if (!isCascade(original)) return flag.ply === original.ply;
    const meta = flag.cascadeMeta;
    const oldPlies = flagPlies(original);
    return meta?.startPly === oldPlies[0] && meta.sequenceLength === oldPlies.length;
  });
  if (emitted) return "recovered";

  if (!isCascade(original)) {
    const loss = resolveCpLoss(freshPoints[original.ply]);
    if (loss && loss.cpLoss < 100) return "fellBelow100cp";
  }
  return "noLongerEmitted";
}

function toParsedGame(game: {
  id: string; playerColor: string; opponentUsername: string; opponentRating: number | null; playerRating: number | null;
  moves: unknown; clocks: unknown; clockInitialSec: number | null; clockIncrementSec: number | null; openingName: string | null;
  openingEco: string | null; result: string; rated: boolean; speed: string | null; lichessCreatedAt: Date | null;
}): ParsedGame {
  return {
    id: game.id,
    playerColor: game.playerColor === "black" ? "black" : "white",
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    moves: Array.isArray(game.moves) && game.moves.every((move) => typeof move === "string") ? game.moves : [],
    clocks: Array.isArray(game.clocks) && game.clocks.every((clock) => typeof clock === "number") ? game.clocks : null,
    clockInitialSec: game.clockInitialSec,
    clockIncrementSec: game.clockIncrementSec,
    openingName: game.openingName,
    openingEco: game.openingEco,
    result: game.result === "win" || game.result === "loss" ? game.result : "draw",
    rated: game.rated,
    speed: game.speed,
    createdAt: game.lichessCreatedAt?.getTime() ?? null,
  };
}

function emptyWeaknessProfile(username: string, gamesFetched: number): WeaknessProfile {
  return {
    username, patterns: [], evaluatedGameIds: [], gamesEvaluated: 0, gamesFetched,
    confidence: "low", builtAt: Date.now(),
  };
}

async function persistGameEvalAndFlags(
  gameId: string,
  gameEval: GameEval,
  flags: ReturnType<typeof flagMoves>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.gameEval.upsert({
      where: { gameId },
      update: {
        points: gameEval.points as unknown as Prisma.InputJsonValue,
        engineVersion: gameEval.engineVersion,
        evaluatedAt: new Date(gameEval.evaluatedAt),
      },
      create: {
        gameId,
        points: gameEval.points as unknown as Prisma.InputJsonValue,
        engineVersion: gameEval.engineVersion,
        evaluatedAt: new Date(gameEval.evaluatedAt),
      },
    });
    await tx.flaggedMove.deleteMany({ where: { gameId } });
    if (flags.length > 0) {
      await tx.flaggedMove.createMany({
        data: flags.map((flag) => ({
          gameId, ply: flag.ply, moveNumber: flag.moveNumber, san: flag.san, color: flag.color,
          flagType: flag.flagType, timeSpentSec: flag.timeSpentSec, phaseAvgSec: flag.phaseAvgSec,
          timeRatio: flag.timeRatio, ratio: flag.ratio, clockRemainingSec: flag.clockRemainingSec,
          gamePhase: flag.gamePhase, cpLoss: flag.cpLoss,
          causality: flag.causality as unknown as Prisma.InputJsonValue,
          matchedWeaknessId: flag.matchedWeaknessId, styleDeviationScore: flag.styleDeviationScore,
          absoluteAnomalyScore: flag.absoluteAnomalyScore, severity: flag.severity,
          severityBreakdown: flag.severityBreakdown as unknown as Prisma.InputJsonValue,
          pivotMove: flag.pivotMove ? flag.pivotMove as unknown as Prisma.InputJsonValue : undefined,
          cascadeMeta: flag.cascadeMeta ? flag.cascadeMeta as unknown as Prisma.InputJsonValue : undefined,
          evalConfidence: flag.evalConfidence, explanation: flag.explanation,
        })),
      });
    }
  });
}

async function main(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  let candidateGames = 0;
  let candidateFlags = 0;
  let evaluatedGames = 0;
  const outcomesBySeverity: Record<string, OutcomeCounts> = {};
  const unreachableGames: string[] = [];
  let engine: StockfishCli | null = null;

  try {
    for (const user of users) {
      const rows = await prisma.game.findMany({
        where: { userId: user.id },
        include: { eval: true, flags: true },
        orderBy: { lichessCreatedAt: "asc" },
      });
      const parsedGames = rows.map(toParsedGame);
      const features = extractAllMoveFeatures(parsedGames);
      const profile = buildPlayerProfile(user.username, parsedGames, features);
      const featuresByGame = new Map<string, typeof features>();
      for (const feature of features) {
        const list = featuresByGame.get(feature.gameId) ?? [];
        list.push(feature);
        featuresByGame.set(feature.gameId, list);
      }
      const weakness = emptyWeaknessProfile(user.username, parsedGames.length);

      for (const row of rows) {
        if (row.flags.length === 0) continue;
        const rawPoints: unknown = row.eval?.points;
        if (!Array.isArray(rawPoints)) {
          candidateGames++;
          candidateFlags += row.flags.length;
          for (const flag of row.flags) {
            const counts = outcomesBySeverity[flag.severity] ??= {
              candidates: 0, recovered: 0, fellBelow100cp: 0, noLongerEmitted: 0, unreachable: 0,
            };
            counts.candidates++;
            counts.unreachable++;
          }
          const unreachable = `${row.lichessGameId}: persisted flags have no saved evaluation`;
          unreachableGames.push(unreachable);
          console.error(`UNREACHABLE: ${unreachable}`);
          continue;
        }
        const game = parsedGames.find((item) => item.id === row.id);
        const shallowFlags = row.flags.filter((flag) => flagPlies(flag).some((ply) => {
          const point: unknown = rawPoints[ply];
          if (typeof point !== "object" || point === null || Array.isArray(point) || !("depth" in point)) return true;
          return typeof point.depth !== "number" || !Number.isFinite(point.depth) || point.depth < 16;
        }));
        if (shallowFlags.length === 0) continue;

        candidateGames++;
        candidateFlags += shallowFlags.length;
        for (const flag of shallowFlags) {
          const counts = outcomesBySeverity[flag.severity] ??= {
            candidates: 0, recovered: 0, fellBelow100cp: 0, noLongerEmitted: 0, unreachable: 0,
          };
          counts.candidates++;
        }

        if (!game || game.moves.length === 0 ||
            game.moves.some((move) => typeof move !== "string") ||
            shallowFlags.some((flag) => flagPlies(flag).some((ply) => ply < 0 || ply >= game.moves.length))) {
          const unreachable = `${row.lichessGameId}: missing or invalid move data for ${shallowFlags.map((flag) => flag.id).join(", ")}`;
          unreachableGames.push(unreachable);
          for (const flag of shallowFlags) outcomesBySeverity[flag.severity].unreachable++;
          console.error(`UNREACHABLE: ${unreachable}`);
          continue;
        }
        console.log(`[candidate ${candidateGames}] ${user.username} ${row.lichessGameId}: ${shallowFlags.length} shallow flag(s)`);
        if (!applyChanges) continue;

        engine ??= await StockfishCli.create();
        let freshEval: GameEval;
        try {
          freshEval = await evaluateServerGame(
            row.id, game.moves, (fen) => engine!.evaluate(fen, 16), undefined, undefined, ENGINE_VERSION,
          );
        } catch (error) {
          engine.close();
          engine = null;
          const message = error instanceof Error ? error.message : String(error);
          const unreachable = `${row.lichessGameId}: depth-16 evaluation failed (${message})`;
          unreachableGames.push(unreachable);
          for (const flag of shallowFlags) outcomesBySeverity[flag.severity].unreachable++;
          console.error(`UNREACHABLE: ${unreachable}`);
          continue;
        }
        if (freshEval.points.some((point) => point.depth < 16)) {
          const shallowDepths = freshEval.points
            .map((point, ply) => ({ ply, depth: point.depth }))
            .filter((point) => point.depth < 16)
            .map((point) => `ply ${point.ply}: depth ${point.depth}`)
            .join(", ");
          const unreachable = `${row.lichessGameId}: target depth 16 not reached (${shallowDepths})`;
          unreachableGames.push(unreachable);
          for (const flag of shallowFlags) outcomesBySeverity[flag.severity].unreachable++;
          console.error(`UNREACHABLE: ${unreachable}`);
          continue;
        }
        const freshFlags = flagMoves(featuresByGame.get(row.id) ?? [], profile, weakness, freshEval, game.playerColor);
        await persistGameEvalAndFlags(row.id, freshEval, freshFlags);
        evaluatedGames++;
        for (const flag of shallowFlags) {
          const outcome = outcomeForFlag(flag, freshEval.points, freshFlags);
          const counts = outcomesBySeverity[flag.severity];
          counts[outcome]++;
        }
        console.log(`[updated ${evaluatedGames}/${candidateGames}] ${row.lichessGameId}`);
      }
    }
  } finally {
    engine?.close();
  }

  console.log(JSON.stringify({
    mode: applyChanges ? "apply" : "dry-run",
    candidateGames,
    shallowFlagsEligibleForBackfill: candidateFlags,
    evaluatedGames,
    outcomesByOriginalSeverity: outcomesBySeverity,
    unreachableGames,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error("Depth-16 borderline-flag backfill failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
