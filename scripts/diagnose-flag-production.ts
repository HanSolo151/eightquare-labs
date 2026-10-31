import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../lib/prisma";
import { extractMoveFeatures } from "../lib/features/extractFeatures";
import { flagMoves, resolveCpLoss } from "../lib/flags/flagEngine";
import { inspectGameEval } from "../lib/eval/evalCache";
import type { EvalPoint, GameEval, ParsedGame, PlayerProfile, WeaknessProfile } from "../types";

const ROOT = process.cwd();
const SAMPLE_LIMIT = 500;
const ENGINE_VERSION = "stockfish-19-lite-single-depth16-target-v3";
const profile: PlayerProfile = {
  username: "diagnostic", gamesAnalyzed: 0,
  avgMoveTimeSecByPhase: { opening: null, middlegame: null, endgame: null },
  premoveRate: 0, mostCommonOpenings: [], avgOpponentRating: null,
};
const weakness: WeaknessProfile = {
  username: "diagnostic", patterns: [], evaluatedGameIds: [], gamesEvaluated: 0,
  gamesFetched: 0, confidence: "low", builtAt: 0,
};

function asParsedGame(game: {
  id: string; playerColor: string; opponentUsername: string; opponentRating: number | null;
  playerRating: number | null; moves: unknown; clocks: unknown; clockInitialSec: number | null;
  clockIncrementSec: number | null; openingName: string | null; openingEco: string | null;
  result: string; rated: boolean; speed: string | null; lichessCreatedAt: Date | null;
}): ParsedGame | null {
  if ((game.playerColor !== "white" && game.playerColor !== "black") ||
      !Array.isArray(game.moves) || !game.moves.every((move) => typeof move === "string")) return null;
  return {
    id: game.id, playerColor: game.playerColor, opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating, playerRating: game.playerRating, moves: game.moves,
    clocks: Array.isArray(game.clocks) && game.clocks.every((clock) => typeof clock === "number") ? game.clocks : null,
    clockInitialSec: game.clockInitialSec, clockIncrementSec: game.clockIncrementSec,
    openingName: game.openingName, openingEco: game.openingEco,
    result: game.result === "win" || game.result === "loss" ? game.result : "draw",
    rated: game.rated, speed: game.speed, createdAt: game.lichessCreatedAt?.getTime() ?? null,
  };
}

function blank() {
  return {
    sampledGames: 0, invalidGames: 0, currentEngineGames: 0, otherEngineGames: 0,
    structurallyComplete: 0, structurallyIncomplete: 0, badEvaluationPoints: 0,
    evalPoints: 0, cpComparablePoints: 0, mateOnlyPoints: 0, depthBelow10Points: 0,
    boundaryScoreContinuityPairs: 0, mismatchedScoreContinuityPairs: 0,
    targetMoves: 0, resolvableLosses: 0, lossesAtLeast100Cp: 0, causalityHeld: 0,
    recomputedFlags: 0, persistedFlags: 0, exactFlagSetMatches: 0, flagSetMismatches: 0,
    fieldMismatches: 0, missingPersistedFlags: 0, stalePersistedFlags: 0,
    bySeverity: { high: 0, medium: 0, low: 0 } as Record<string, number>,
    byType: {} as Record<string, number>, byConfidence: {} as Record<string, number>,
    engineVersions: {} as Record<string, number>, flagCpLoss: [] as number[],
  };
}

async function main() {
  const totalEvaluatedGames = await prisma.game.count({ where: { eval: { isNot: null } } });
  const games = await prisma.game.findMany({
    where: { eval: { isNot: null } },
    orderBy: [{ lichessCreatedAt: "desc" }, { createdAt: "desc" }],
    take: SAMPLE_LIMIT,
    select: {
      id: true, playerColor: true, opponentUsername: true, opponentRating: true, playerRating: true,
      moves: true, clocks: true, clockInitialSec: true, clockIncrementSec: true,
      openingName: true, openingEco: true, result: true, rated: true, speed: true,
      lichessCreatedAt: true,
      eval: { select: { points: true, engineVersion: true, evaluatedAt: true } },
      flags: { select: { ply: true, moveNumber: true, san: true, color: true, flagType: true,
        cpLoss: true, severity: true, evalConfidence: true, severityBreakdown: true, explanation: true } },
    },
  });
  const stats = blank();
  stats.sampledGames = games.length;
  const sampledVersions = new Set<string>();

  for (const game of games) {
    const parsed = asParsedGame(game);
    if (!parsed || !game.eval || !Array.isArray(game.eval.points)) { stats.invalidGames++; continue; }
    const points = game.eval.points as unknown as EvalPoint[];
    const evaluation: GameEval = {
      gameId: game.id, points, evaluatedAt: game.eval.evaluatedAt.getTime(), engineVersion: game.eval.engineVersion,
    };
    sampledVersions.add(game.eval.engineVersion);
    stats.engineVersions[game.eval.engineVersion] = (stats.engineVersions[game.eval.engineVersion] ?? 0) + 1;
    if (game.eval.engineVersion === ENGINE_VERSION) stats.currentEngineGames++;
    else stats.otherEngineGames++;

    const quality = inspectGameEval(evaluation, parsed.moves.length);
    if (quality.structurallyComplete) stats.structurallyComplete++;
    else stats.structurallyIncomplete++;
    if (quality.invalidScorePlies.length || quality.invalidDepthPlies.length) stats.badEvaluationPoints += 1;
    stats.evalPoints += points.length;
    stats.cpComparablePoints += quality.cpComparablePlies.length;
    stats.mateOnlyPoints += quality.mateOnlyPlies.length;
    stats.depthBelow10Points += points.filter((point) => Number.isFinite(point.depth) && point.depth < 10).length;

    for (let i = 0; i + 1 < points.length; i++) {
      const left = points[i], right = points[i + 1];
      if (Number.isFinite(left.cpAfter) && Number.isFinite(right.cpBefore)) {
        stats.boundaryScoreContinuityPairs++;
        if (Math.abs((left.cpAfter as number) + (right.cpBefore as number)) > 1) stats.mismatchedScoreContinuityPairs++;
      } else if (Number.isFinite(left.mateAfter) && Number.isFinite(right.mateBefore)) {
        stats.boundaryScoreContinuityPairs++;
        if ((left.mateAfter as number) + (right.mateBefore as number) !== 0) stats.mismatchedScoreContinuityPairs++;
      }
    }

    const features = extractMoveFeatures(parsed);
    stats.targetMoves += features.filter((move) => move.color === parsed.playerColor).length;
    for (const feature of features) {
      if (feature.color !== parsed.playerColor) continue;
      const point = points.find((entry) => entry.ply === feature.ply);
      const loss = point ? resolveCpLoss(point) : null;
      if (!loss) continue;
      stats.resolvableLosses++;
      if (loss.cpLoss >= 100) stats.lossesAtLeast100Cp++;
    }
    const fresh = flagMoves(features, profile, weakness, evaluation, parsed.playerColor);
    stats.recomputedFlags += fresh.length;
    stats.persistedFlags += game.flags.length;
    const key = (flag: { ply: number; flagType: string }) => `${flag.ply}:${flag.flagType}`;
    const freshByKey = new Map(fresh.map((flag) => [key(flag), flag]));
    const storedByKey = new Map(game.flags.map((flag) => [key(flag), flag]));
    if (freshByKey.size === storedByKey.size && [...freshByKey.keys()].every((id) => storedByKey.has(id))) stats.exactFlagSetMatches++;
    else {
      stats.flagSetMismatches++;
      stats.missingPersistedFlags += [...freshByKey.keys()].filter((id) => !storedByKey.has(id)).length;
      stats.stalePersistedFlags += [...storedByKey.keys()].filter((id) => !freshByKey.has(id)).length;
    }
    for (const [id, expected] of freshByKey) {
      const stored = storedByKey.get(id);
      if (!stored) continue;
      if (Math.round(stored.cpLoss) !== expected.cpLoss || stored.severity !== expected.severity ||
          stored.san !== expected.san || stored.color !== expected.color || stored.evalConfidence !== expected.evalConfidence) {
        stats.fieldMismatches++;
      }
    }
    for (const flag of fresh) {
      stats.bySeverity[flag.severity] = (stats.bySeverity[flag.severity] ?? 0) + 1;
      stats.byType[flag.flagType] = (stats.byType[flag.flagType] ?? 0) + 1;
      stats.byConfidence[flag.evalConfidence] = (stats.byConfidence[flag.evalConfidence] ?? 0) + 1;
      stats.flagCpLoss.push(flag.cpLoss);
    }
    stats.causalityHeld += fresh.filter((flag) => flag.causality.heldToEnd).length;
  }

  const losses = stats.flagCpLoss.sort((a, b) => a - b);
  const percentile = (p: number) => losses.length ? losses[Math.min(losses.length - 1, Math.floor((losses.length - 1) * p))] : null;
  const report = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only sample of latest evaluated production games; no identifiers retained in report.",
    totalEvaluatedGames,
    sampledGames: stats.sampledGames,
    sampleLimit: SAMPLE_LIMIT,
    engineVersions: stats.engineVersions,
    metrics: {
      ...stats,
      flagCpLoss: undefined,
      flagCpLossPercentiles: { p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99) },
      scoreContinuityRate: stats.boundaryScoreContinuityPairs
        ? 1 - stats.mismatchedScoreContinuityPairs / stats.boundaryScoreContinuityPairs : null,
      flagSetParityRate: stats.sampledGames - stats.invalidGames
        ? stats.exactFlagSetMatches / (stats.sampledGames - stats.invalidGames) : null,
    },
    limitations: [
      "Flag-to-persisted parity measures reproducibility, not correctness against human annotations; persisted flags are generated by the same rule.",
      "No independent chess-expert labels are present in the database, so precision, recall, and false-positive rates cannot be estimated.",
      "The sample is the latest evaluated games, not a random sample of all historical games.",
      "Stockfish scores are not independent ground truth; fixed-depth search instability and engine bias remain unmeasured by parity.",
    ],
  };
  const outDir = join(ROOT, "artifacts", "evaluation");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "flagging-production-diagnostic.json"), `${JSON.stringify(report, null, 2)}\n`);
  const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(2)}%` : "n/a";
  const markdown = [
    "# Production flagging diagnostic",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Read-only audit of ${stats.sampledGames} of ${totalEvaluatedGames} evaluated games (latest first). No user/game identifiers are stored in this report.`,
    "",
    "## Reproducibility and evaluation data",
    "",
    "| Measure | Result |",
    "|---|---:|",
    `| Games sampled | ${stats.sampledGames} |`,
    `| Current engine version | ${stats.currentEngineGames} |`,
    `| Other engine versions | ${stats.otherEngineGames} |`,
    `| Complete eval records | ${stats.structurallyComplete}/${stats.sampledGames} (${pct(stats.structurallyComplete, stats.sampledGames)}) |`,
    `| Games with invalid score/depth points | ${stats.badEvaluationPoints} |`,
    `| Per-ply boundary score consistency | ${stats.boundaryScoreContinuityPairs - stats.mismatchedScoreContinuityPairs}/${stats.boundaryScoreContinuityPairs} (${pct(stats.boundaryScoreContinuityPairs - stats.mismatchedScoreContinuityPairs, stats.boundaryScoreContinuityPairs)}) |`,
    `| Persisted flag sets equal fresh recomputation | ${stats.exactFlagSetMatches}/${stats.sampledGames - stats.invalidGames} (${pct(stats.exactFlagSetMatches, stats.sampledGames - stats.invalidGames)}) |`,
    `| Flag-field mismatches among matching keys | ${stats.fieldMismatches} |`,
    "",
    "## What the current flag rules emitted",
    "",
    `| Measure | Count |`,
    `|---|---:|`,
    `| Target-player moves | ${stats.targetMoves} |`,
    `| Resolvable before/after evaluations | ${stats.resolvableLosses} |`,
    `| Resolved losses >= 100 cp before recovery filter | ${stats.lossesAtLeast100Cp} |`,
    `| Recomputed flags | ${stats.recomputedFlags} |`,
    `| Causality-held flags | ${stats.causalityHeld} |`,
    `| Confidence buckets | ${JSON.stringify(stats.byConfidence)} |`,
    `| Severity buckets | ${JSON.stringify(stats.bySeverity)} |`,
    `| Flag types | ${JSON.stringify(stats.byType)} |`,
    `| Flag cp-loss p50 / p90 / p99 | ${percentile(0.5)} / ${percentile(0.9)} / ${percentile(0.99)} |`,
    "",
    "## Interpretation limits",
    "",
    "Exact recomputation parity proves the persisted output matches the current deterministic calculation for this sample. It does not prove the labels are true chess mistakes: both stored output and recomputation use the same fixed-depth Stockfish eval and same thresholds.",
    "",
    "No human-annotated labels are stored, so precision, recall, and false-positive rate cannot be honestly calculated from this database. An expert review sample is needed for label accuracy.",
    "",
    "Other code findings: ordinary flags are always `decision_error`; the profile/weakness inputs and time pressure are not used to classify flags; severity bonuses are zero; low severity is unreachable because flags require >=100 cp (medium at 100–200, high above 200); cascades require 2–4 consecutive own moves with >=50 cp each, >=250 cp total, full confidence, and an unrecovered first-move loss.",
    "",
    "Caution: the evaluation-push API validates score shape and depth but does not cryptographically verify Stockfish provenance. Since the client submits evaluations, an authenticated client can forge plausible scores; current server recomputation protects canonical move identity, not evaluation authenticity.",
    "",
  ].join("\n");
  await writeFile(join(outDir, "flagging-production-diagnostic.md"), markdown);
  console.log(JSON.stringify({
    totalEvaluatedGames, sampledGames: stats.sampledGames,
    currentEngineGames: stats.currentEngineGames, engineVersions: stats.engineVersions,
    structurallyComplete: stats.structurallyComplete,
    badEvaluationPoints: stats.badEvaluationPoints,
    continuityPairs: stats.boundaryScoreContinuityPairs,
    continuityMismatches: stats.mismatchedScoreContinuityPairs,
    exactFlagSetMatches: stats.exactFlagSetMatches,
    flagSetMismatches: stats.flagSetMismatches,
    fieldMismatches: stats.fieldMismatches,
    recomputedFlags: stats.recomputedFlags,
    bySeverity: stats.bySeverity, byType: stats.byType, byConfidence: stats.byConfidence,
    output: "artifacts/evaluation/flagging-production-diagnostic.md",
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error("Production flagging diagnostic failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
