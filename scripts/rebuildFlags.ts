import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { EvalPoint, GameEval, ParsedGame, WeaknessProfile } from "../types";
import { buildPlayerProfile, extractAllMoveFeatures } from "../lib/features/extractFeatures";
import { flagMoves } from "../lib/flags/flagEngine";
import { updateWeaknessProfile } from "../lib/profile/weaknessProfile";

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

async function main(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  let gamesRebuilt = 0;
  let flagsWritten = 0;

  for (const user of users) {
    const rows = await prisma.game.findMany({
      where: { userId: user.id },
      include: { eval: true },
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
      if (!row.eval || !Array.isArray(row.eval.points)) continue;
      const game = parsedGames.find((item) => item.id === row.id);
      if (!game) continue;
      const gameEval: GameEval = {
        gameId: row.id,
        points: row.eval.points as unknown as EvalPoint[],
        evaluatedAt: row.eval.evaluatedAt.getTime(),
        engineVersion: row.eval.engineVersion,
      };
      const gameFeatures = featuresByGame.get(row.id) ?? [];
      const flags = flagMoves(gameFeatures, profile, weakness, gameEval, game.playerColor);
      updateWeaknessProfile(weakness, row.id, gameEval, gameFeatures, game.playerColor);

      await prisma.$transaction(async (tx) => {
        await tx.flaggedMove.deleteMany({ where: { gameId: row.id } });
        if (flags.length > 0) {
          await tx.flaggedMove.createMany({
            data: flags.map((flag) => ({
              gameId: row.id, ply: flag.ply, moveNumber: flag.moveNumber, san: flag.san, color: flag.color,
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
      gamesRebuilt++;
      flagsWritten += flags.length;
    }

    await prisma.weaknessProfileRow.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id, patterns: weakness.patterns as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: weakness.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        gamesEvaluated: weakness.gamesEvaluated, gamesFetched: weakness.gamesFetched,
        confidence: weakness.confidence,
      },
      update: {
        patterns: weakness.patterns as unknown as Prisma.InputJsonValue,
        evaluatedGameIds: weakness.evaluatedGameIds as unknown as Prisma.InputJsonValue,
        gamesEvaluated: weakness.gamesEvaluated, gamesFetched: weakness.gamesFetched,
        confidence: weakness.confidence, builtAt: new Date(weakness.builtAt),
      },
    });
    console.log(`Rebuilt ${user.username}: ${gamesRebuilt} total games, ${flagsWritten} total flags so far.`);
  }

  console.log(`Done. Rebuilt flags for ${gamesRebuilt} evaluated games; wrote ${flagsWritten} flags.`);
}

main().catch((error) => {
  console.error("Flag rebuild failed", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
