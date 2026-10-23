import { Chess } from "chess.js";
import { MATCHING_CONFIG } from "@/config/matching";
import { prisma } from "@/lib/prisma";
import type { EvalPoint, FlaggedMove, GameEval, ParsedGame } from "@/types";
import { computeGameVector, normalizeStyleVector } from "./computeGameVector";
import { gateBigshotMatch, type PhaseCorpusProfile, type RecentBigshotMoment } from "./gates";
import { findNearestBigshots } from "./profileMatcher";
import { PHASES, isStyleVector, type MatchPhase, type PhaseVectorCalibration } from "./vectorSchema";

interface PersistableGame {
  id: string;
  lichessGameId: string;
  playerColor: string;
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  moves: unknown;
  clocks: unknown;
  openingName: string | null;
  openingEco: string | null;
  result: string;
  rated: boolean;
  speed: string | null;
  lichessCreatedAt: Date | null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCalibration(value: unknown): PhaseVectorCalibration | null {
  const record = jsonRecord(value);
  const means = record?.means;
  const stdDevs = record?.stdDevs;
  const sampleSize = record?.sampleSize;
  if (!isStyleVector(means) || !isStyleVector(stdDevs) || typeof sampleSize !== "number") return null;
  return { means, stdDevs, sampleSize };
}

function readEvalPoints(value: unknown): EvalPoint[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((point): point is EvalPoint => {
    const record = jsonRecord(point);
    return Boolean(record && Number.isInteger(record.ply)
      && (record.cpBefore === null || typeof record.cpBefore === "number")
      && (record.cpAfter === null || typeof record.cpAfter === "number")
      && (record.mateBefore === null || typeof record.mateBefore === "number")
      && (record.mateAfter === null || typeof record.mateAfter === "number")
      && typeof record.depth === "number");
  });
}

function readMoves(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((move) => typeof move === "string") ? value : null;
}

function readClocks(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((clock) => typeof clock === "number" && Number.isFinite(clock))
    ? value
    : null;
}

function phaseAt(ply: number): MatchPhase {
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.openingEnd) return "opening";
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.middlegameEnd) return "middlegame";
  return "endgame";
}

function positionsBeforeMoves(moves: string[]): string[] {
  const chess = new Chess();
  return moves.map((move) => {
    const fen = chess.fen();
    chess.move(move);
    return fen;
  });
}

/** Creates idempotent match candidates after an evaluated game is persisted. */
export async function createGameMoments(
  userId: string,
  game: PersistableGame,
  rawEvaluation: unknown,
  flags: FlaggedMove[],
): Promise<number> {
  if (game.result !== "win" && !(game.result === "draw" && MATCHING_CONFIG.INCLUDE_DRAW_RESULTS)) return 0;
  if (game.playerColor !== "white" && game.playerColor !== "black") return 0;
  const moves = readMoves(game.moves);
  const points = readEvalPoints(jsonRecord(rawEvaluation)?.points);
  if (!moves || !points || points.length !== moves.length) return 0;

  const [calibrationRows, profileRows, sampleRows] = await Promise.all([
    prisma.bigshotVectorCalibration.findMany(),
    prisma.bigshotPhaseProfile.findMany({ include: { bigshot: { select: { name: true } } } }),
    prisma.bigshotSampleGame.findMany({ select: { id: true, bigshotId: true, phase: true } }),
  ]);

  const calibrations = new Map<MatchPhase, PhaseVectorCalibration>();
  for (const row of calibrationRows) {
    if (!PHASES.includes(row.phase as MatchPhase)) continue;
    const calibration = readCalibration({ means: row.means, stdDevs: row.stdDevs, sampleSize: row.sampleSize });
    if (calibration) calibrations.set(row.phase as MatchPhase, calibration);
  }
  const profilesByBigshotId: Record<string, PhaseCorpusProfile | undefined> = {};
  const candidatesByPhase: Record<MatchPhase, Array<{ bigshotId: string; phase: MatchPhase; vector: unknown; motifMatch: boolean }>> = {
    opening: [], middlegame: [], endgame: [],
  };
  for (const profile of profileRows) {
    if (!PHASES.includes(profile.phase as MatchPhase)) continue;
    const phase = profile.phase as MatchPhase;
    profilesByBigshotId[`${profile.bigshotId}:${phase}`] = { phase, sampleSize: profile.sampleSize };
    candidatesByPhase[phase].push({ bigshotId: profile.bigshotId, phase, vector: profile.vector, motifMatch: false });
  }
  if (calibrations.size !== PHASES.length || profileRows.length === 0) return 0;

  const parsed: ParsedGame = {
    id: game.lichessGameId,
    playerColor: game.playerColor,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    moves,
    clocks: readClocks(game.clocks),
    openingName: game.openingName,
    openingEco: game.openingEco,
    result: game.result as ParsedGame["result"],
    rated: game.rated,
    speed: game.speed,
    createdAt: game.lichessCreatedAt?.getTime() ?? null,
  };
  const validFlags = flags.filter((flag) => flag.color === game.playerColor && flag.ply >= 0 && flag.ply < moves.length);
  if (validFlags.length === 0) return 0;
  const rawVectors = computeGameVector(parsed, {
    gameId: game.lichessGameId,
    points,
    evaluatedAt: Date.now(),
    engineVersion: typeof jsonRecord(rawEvaluation)?.engineVersion === "string" ? jsonRecord(rawEvaluation)!.engineVersion as string : "unknown",
  } satisfies GameEval, validFlags);
  const positions = positionsBeforeMoves(moves);
  const recentCutoff = new Date(Date.now() - MATCHING_CONFIG.VARIETY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const recentRows = await prisma.gameMoment.findMany({
    where: { userId, createdAt: { gte: recentCutoff }, matchedBigshotId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MATCHING_CONFIG.VARIETY_LOOKBACK_COUNT,
    select: { matchedBigshotId: true, createdAt: true },
  });
  const recentMoments: RecentBigshotMoment[] = recentRows;
  const createdAt = new Date();
  const rows: Array<{
    userId: string; gameId: string; ply: number; phase: MatchPhase; moveNumber: number; san: string;
    fenBeforeMove: string; evalBefore: number | null; evalAfter: number | null; soundness: string;
    matchedBigshotId: string; matchDistance: number; motifMatch: boolean; sampleGameId: string;
    status: "matched"; createdAt: Date;
  }> = [];

  for (const flag of validFlags) {
    const phase = phaseAt(flag.ply);
    const rawVector = rawVectors[phase];
    const calibration = calibrations.get(phase);
    if (!rawVector || !calibration) continue;
    const normalized = normalizeStyleVector(rawVector, calibration);
    const ranked = findNearestBigshots(normalized, phase, candidatesByPhase[phase]);
    const point = points[flag.ply];
    if (!point) continue;
    const decision = gateBigshotMatch({
      result: parsed.result,
      evalBefore: point.cpBefore === null ? null : point.cpBefore / 100,
      evalAfter: point.cpAfter === null ? null : point.cpAfter / 100,
      phase,
      findMatches: () => ranked,
      profilesByBigshotId,
      recentMoments,
      now: createdAt,
    });
    if (!decision.pass) continue;
    const sample = sampleRows.find((item) => item.bigshotId === decision.value.match.bigshotId && item.phase === phase);
    if (!sample) continue;
    rows.push({
      userId,
      gameId: game.id,
      ply: flag.ply,
      phase,
      moveNumber: flag.moveNumber,
      san: flag.san,
      fenBeforeMove: positions[flag.ply],
      evalBefore: point.cpBefore === null ? null : point.cpBefore / 100,
      evalAfter: point.cpAfter === null ? null : point.cpAfter / 100,
      soundness: decision.value.soundness,
      matchedBigshotId: decision.value.match.bigshotId,
      matchDistance: decision.value.match.distance,
      motifMatch: decision.value.match.motifMatch,
      sampleGameId: sample.id,
      status: "matched",
      createdAt,
    });
    recentMoments.unshift({ matchedBigshotId: decision.value.match.bigshotId, createdAt });
    recentMoments.splice(MATCHING_CONFIG.VARIETY_LOOKBACK_COUNT);
  }

  if (rows.length === 0) return 0;
  const result = await prisma.gameMoment.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}
