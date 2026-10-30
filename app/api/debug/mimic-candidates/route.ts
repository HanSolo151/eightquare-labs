import { Chess } from "chess.js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildOpponentFeaturesFromGames } from "@/lib/lichess/opponentFeatures";
import { detectMaterialSacrifices } from "@/lib/style/sacrificeDetector";
import type { GameEval, ParsedGame } from "@/types";

const MIN_GAMES_PER_OPPONENT = 5;
const MAX_SELECTED_GAMES = 100;
type SacrificeSummary = { evaluatedEvents: number; compensated: number; blunders: number; uncertain: number };
type CandidateProfile = {
  username: string;
  aggressionIndex: number;
  queenTradeRate: number;
  forcingMoveRate: number;
  trainGameCount: number;
  trainGames: ParsedGame[];
  heldOutGames: ParsedGame[];
  sacrifices: SacrificeSummary;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validEvalPoints(value: unknown, expectedPlyCount: number): GameEval["points"] | null {
  if (!Array.isArray(value) || value.length !== expectedPlyCount) return null;
  for (let ply = 0; ply < value.length; ply++) {
    const point = value[ply];
    if (!point || typeof point !== "object" || Array.isArray(point)) return null;
    const row = point as Record<string, unknown>;
    const validScore = (score: unknown) => score === null || typeof score === "number" && Number.isFinite(score);
    if (row.ply !== ply || !validScore(row.cpBefore) || !validScore(row.cpAfter) ||
        !validScore(row.mateBefore) || !validScore(row.mateAfter) ||
        typeof row.depth !== "number" || !Number.isFinite(row.depth)) return null;
  }
  return value as GameEval["points"];
}

function toOpponentGame(row: {
  lichessGameId: string;
  playerColor: string;
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  moves: unknown;
  clocks: unknown;
  clockInitialSec: number | null;
  clockIncrementSec: number | null;
  openingName: string | null;
  openingEco: string | null;
  result: string;
  rated: boolean;
  speed: string | null;
  lichessCreatedAt: Date | null;
  eval: { points: unknown; engineVersion: string; evaluatedAt: Date } | null;
}): { game: ParsedGame; evaluation: GameEval } | null {
  if (!row.eval || (row.playerColor !== "white" && row.playerColor !== "black") || !isStringArray(row.moves)) return null;
  const points = validEvalPoints(row.eval.points, row.moves.length);
  if (!points) return null;

  const playerColor = row.playerColor === "white" ? "black" : "white";
  const result = row.result === "win" || row.result === "loss" ? row.result : "draw";
  const opponentResult = result === "win" ? "loss" : result === "loss" ? "win" : "draw";
  const clocks = Array.isArray(row.clocks) && row.clocks.every((clock) => typeof clock === "number" && Number.isFinite(clock))
    ? row.clocks as number[]
    : null;

  const game: ParsedGame = {
    id: row.lichessGameId,
    playerColor,
    opponentUsername: "account owner",
    opponentRating: row.playerRating,
    playerRating: row.opponentRating,
    moves: row.moves,
    clocks,
    clockInitialSec: row.clockInitialSec,
    clockIncrementSec: row.clockIncrementSec,
    openingName: row.openingName,
    openingEco: row.openingEco,
    result: opponentResult,
    rated: row.rated,
    speed: row.speed,
    createdAt: row.lichessCreatedAt?.getTime() ?? null,
  };
  const evaluation: GameEval = {
    gameId: game.id,
    points,
    engineVersion: row.eval.engineVersion,
    evaluatedAt: row.eval.evaluatedAt.getTime(),
  };
  return { game, evaluation };
}

function analyzeGame(game: ParsedGame, evaluation: GameEval): { forcingMoves: number; ownMoves: number; sacrifices: SacrificeSummary } {
  const chess = new Chess();
  let forcingMoves = 0;
  let ownMoves = 0;
  for (let ply = 0; ply < game.moves.length; ply++) {
    let move;
    try { move = chess.move(game.moves[ply]); } catch { break; }
    if (!move) break;
    if ((ply % 2 === 0 ? "white" : "black") !== game.playerColor) continue;
    ownMoves++;
    if (move.captured || chess.isCheck()) forcingMoves++;
  }

  const sacrifices = detectMaterialSacrifices(game, evaluation);
  return {
    forcingMoves,
    ownMoves,
    sacrifices: {
      evaluatedEvents: sacrifices.length,
      compensated: sacrifices.filter((event) => event.outcome === "compensated").length,
      blunders: sacrifices.filter((event) => event.outcome === "blunder").length,
      uncertain: sacrifices.filter((event) => event.outcome === "uncertain").length,
    },
  };
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await prisma.game.findMany({
    where: { userId, eval: { isNot: null } },
    select: {
      lichessGameId: true,
      playerColor: true,
      opponentUsername: true,
      opponentRating: true,
      playerRating: true,
      moves: true,
      clocks: true,
      clockInitialSec: true,
      clockIncrementSec: true,
      openingName: true,
      openingEco: true,
      result: true,
      rated: true,
      speed: true,
      lichessCreatedAt: true,
      eval: { select: { points: true, engineVersion: true, evaluatedAt: true } },
    },
    orderBy: [{ lichessCreatedAt: "asc" }, { id: "asc" }],
  });

  const grouped = new Map<string, { username: string; games: Array<{ game: ParsedGame; evaluation: GameEval }> }>();
  for (const row of rows) {
    const normalized = toOpponentGame(row);
    if (!normalized) continue;
    const username = row.opponentUsername.trim();
    if (!username || username.toLowerCase() === "anonymous") continue;
    const key = username.toLowerCase();
    const group = grouped.get(key) ?? { username, games: [] };
    group.games.push(normalized);
    grouped.set(key, group);
  }

  const candidates: CandidateProfile[] = [];
  for (const group of grouped.values()) {
    if (group.games.length < MIN_GAMES_PER_OPPONENT) continue;
    const split = Math.floor(group.games.length * 0.8);
    const train = group.games.slice(0, split);
    const heldOut = group.games.slice(split);
    if (train.length === 0 || heldOut.length === 0) continue;

    let forcingMoves = 0;
    let ownMoves = 0;
    const sacrifices: SacrificeSummary = { evaluatedEvents: 0, compensated: 0, blunders: 0, uncertain: 0 };
    for (const { game, evaluation } of train) {
      const analyzed = analyzeGame(game, evaluation);
      forcingMoves += analyzed.forcingMoves;
      ownMoves += analyzed.ownMoves;
      for (const key of Object.keys(sacrifices) as Array<keyof SacrificeSummary>) sacrifices[key] += analyzed.sacrifices[key];
    }
    const trainingGames = train.map(({ game }) => game);
    const opponentFeatures = buildOpponentFeaturesFromGames(group.username, trainingGames);
    candidates.push({
      username: group.username,
      aggressionIndex: opponentFeatures.aggressionIndex,
      queenTradeRate: opponentFeatures.queenTradeRate,
      forcingMoveRate: ownMoves > 0 ? forcingMoves / ownMoves : 0,
      trainGameCount: train.length,
      trainGames: trainingGames,
      heldOutGames: heldOut.slice(0, MAX_SELECTED_GAMES).map(({ game }) => game),
      sacrifices,
    });
  }

  // Select the style extremes using the same training-only aggression feature
  // consumed by the current reranker. Keep the raw capture/check rate visible
  // as a diagnostic, but do not use that partial proxy as the selector.
  const ordered = candidates.sort((a, b) => a.aggressionIndex - b.aggressionIndex || a.username.localeCompare(b.username));
  if (ordered.length < 2) {
    return NextResponse.json({ error: "Need at least two opponents with five or more fully evaluated games.", candidateCount: ordered.length }, { status: 422 });
  }
  return NextResponse.json({
    candidateCount: ordered.length,
    selected: [ordered[0], ordered[ordered.length - 1]],
  });
}
