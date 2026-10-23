import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Chess } from "chess.js";
import { prisma } from "../lib/prisma";
import { computeGameVectorDetails, normalizeStyleVector } from "../lib/matching/computeGameVector";
import { findNearestBigshots } from "../lib/matching/profileMatcher";
import { MATCHING_CONFIG } from "../config/matching";
import { isStyleVector, PHASES, type MatchPhase, type VectorCalibration } from "../lib/matching/vectorSchema";
import type { EvalPoint, GameEval, ParsedGame } from "../types";

const countArg = Number.parseInt(process.argv[2] ?? "50", 10);
const take = Number.isInteger(countArg) && countArg > 0 ? Math.min(countArg, 500) : 50;
const outputPath = path.join(process.cwd(), "artifacts", "profile-matcher-dry-run.json");

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function asEvalPoints(value: unknown): EvalPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter((point): point is EvalPoint => {
    if (!point || typeof point !== "object") return false;
    const row = point as Partial<EvalPoint>;
    return Number.isInteger(row.ply) &&
      (row.cpBefore === null || typeof row.cpBefore === "number") &&
      (row.cpAfter === null || typeof row.cpAfter === "number") &&
      Number.isFinite(row.depth);
  });
}

function calibrationForRows(rows: Array<{ phase: string; means: unknown; stdDevs: unknown; sampleSize: number }>): VectorCalibration | null {
  const byPhase = Object.fromEntries(rows.map((row) => [row.phase, { means: row.means, stdDevs: row.stdDevs, sampleSize: row.sampleSize }]));
  const result: Partial<VectorCalibration> = {};
  for (const phase of PHASES) {
    const entry = byPhase[phase] as { means: unknown; stdDevs: unknown; sampleSize: number } | undefined;
    if (!entry || !isStyleVector(entry.means) || !isStyleVector(entry.stdDevs)) return null;
    result[phase] = { means: entry.means, stdDevs: entry.stdDevs, sampleSize: entry.sampleSize };
  }
  return result as VectorCalibration;
}

function fenBeforePly(moves: string[], ply: number): string | null {
  const chess = new Chess();
  try {
    for (let index = 0; index < ply; index++) chess.move(moves[index]);
    return chess.fen();
  } catch {
    return null;
  }
}

function phaseForPly(ply: number): MatchPhase {
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.openingEnd) return "opening";
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.middlegameEnd) return "middlegame";
  return "endgame";
}

async function main(): Promise<void> {
  const [calibrationRows, profileRows, games] = await Promise.all([
    prisma.bigshotVectorCalibration.findMany(),
    prisma.bigshotPhaseProfile.findMany({ include: { bigshot: { select: { name: true } } } }),
    prisma.game.findMany({
      where: { result: "win", eval: { isNot: null }, flags: { some: {} } },
      include: { eval: true, flags: true },
      orderBy: { lichessCreatedAt: "desc" },
      take,
    }),
  ]);
  const calibration = calibrationForRows(calibrationRows);
  const bigshotById = new Map<string, string>();
  const profilesByPhase = new Map<MatchPhase, Array<{ bigshotId: string; phase: MatchPhase; vector: unknown }>>();
  for (const row of profileRows) {
    if (!PHASES.includes(row.phase as MatchPhase) || !isStyleVector(row.vector)) continue;
    const phase = row.phase as MatchPhase;
    bigshotById.set(row.bigshotId, row.bigshot.name);
    profilesByPhase.set(phase, [...(profilesByPhase.get(phase) ?? []), { bigshotId: row.bigshotId, phase, vector: row.vector }]);
  }

  const results: Array<Record<string, unknown>> = [];
  let workedExample: Record<string, unknown> | null = null;
  for (const row of games) {
    if (!row.eval) continue;
    const game: ParsedGame = {
      id: row.id,
      playerColor: row.playerColor === "black" ? "black" : "white",
      opponentUsername: row.opponentUsername,
      opponentRating: row.opponentRating,
      playerRating: row.playerRating,
      moves: asStringArray(row.moves),
      clocks: Array.isArray(row.clocks) && row.clocks.every((clock) => typeof clock === "number")
        ? row.clocks as number[] : null,
      openingName: row.openingName,
      openingEco: row.openingEco,
      result: "win",
      rated: row.rated,
      speed: row.speed,
      createdAt: row.lichessCreatedAt?.getTime() ?? null,
    };
    const evaluation: GameEval = {
      gameId: row.id,
      points: asEvalPoints(row.eval.points),
      evaluatedAt: row.eval.evaluatedAt.getTime(),
      engineVersion: row.eval.engineVersion,
    };
    const flags = row.flags.map((flag) => ({ ply: flag.ply, gamePhase: flag.gamePhase as MatchPhase, color: flag.color as "white" | "black" }));
    const { vectors, diagnostics } = computeGameVectorDetails(game, evaluation, flags);
    const perPhase = PHASES.map((phase) => {
      const raw = vectors[phase];
      if (!raw) return { phase, top3: [], rawVector: null };
      const normalized = calibration ? normalizeStyleVector(raw, calibration[phase]) : null;
      const matches = normalized
        ? findNearestBigshots(normalized, phase, profilesByPhase.get(phase) ?? []).slice(0, 3)
        : [];
      if (!workedExample) {
        const flag = flags.find((candidate) => phaseForPly(candidate.ply) === phase);
        workedExample = {
          gameId: game.id,
          phase,
          flagPly: flag?.ply ?? null,
          flagSan: flag ? game.moves[flag.ply] : null,
          fenBeforeMove: flag ? fenBeforePly(game.moves, flag.ply) : null,
          rawVector: raw,
          normalizedVector: normalized,
          diagnostics: diagnostics[phase],
          top3: matches.map((match) => ({ bigshotName: bigshotById.get(match.bigshotId) ?? match.bigshotId, distance: match.distance })),
        };
      }
      return {
        phase,
        top3: matches.map((match) => ({ bigshotName: bigshotById.get(match.bigshotId) ?? match.bigshotId, distance: match.distance })),
        rawVector: raw,
        normalizedVector: normalized,
      };
    });
    results.push({ gameId: game.id, phases: perPhase });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    requestedGames: take,
    analyzedGames: results.length,
    bigshotProfileCount: profileRows.length,
    calibrationAvailable: calibration !== null,
    status: calibration && profileRows.length > 0 ? "ready_for_human_review" : "blocked_missing_corpus_or_calibration",
    workedExample,
    results,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const result of results) console.log(JSON.stringify({ gameId: result.gameId, phases: result.phases }));
  console.log(JSON.stringify({ outputPath, status: report.status, analyzedGames: results.length, bigshotProfileCount: profileRows.length }));
}

main().catch((error) => {
  console.error("Profile matcher dry run failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
