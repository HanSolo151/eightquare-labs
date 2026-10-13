import { Chess } from "chess.js";
import { fetchGames } from "./fetchGames";
import { parseGames } from "./parseGame";
import type { ParsedGame } from "../../types";

/**
 * Opponent profile used by Step 9's reranking layer.
 * Deliberately smaller/shallower than PlayerProfile (Step 3) — this is a
 * lightweight, on-demand lookup triggered per flagged-move click, not a
 * deep per-move dataset.
 */
export interface OpponentFeatures {
  username: string;
  gamesAnalyzed: number;
  mostCommonOpenings: { name: string; eco: string; count: number }[];
  queenTradeRate: number; // 0-1, fraction of games where both queens are off by move 25
  aggressionIndex: number; // 0-1, blended capture/check/early-queen-move rate
  avgRating: number | null;
  fetchedAt: number; // epoch ms, for cache TTL in the API route
}

const QUEEN_TRADE_CUTOFF_PLY = 50; // move 25 full-move == ply 50
const AGGRESSION_EARLY_QUEEN_PLY_CUTOFF = 30; // move 15 full-move == ply 30

/**
 * Replays a single game through chess.js to determine:
 * - whether both queens are off the board by QUEEN_TRADE_CUTOFF_PLY
 * - capture count, check count, and whether the opponent moved their own
 *   queen before AGGRESSION_EARLY_QUEEN_PLY_CUTOFF
 *
 * Only looks at the opponent's own moves (the color opposite playerColor
 * from the ORIGINAL fetch context is irrelevant here — these are the
 * opponent's OWN games, so "opponent's moves" = whichever color the
 * opponent played in that specific game, tracked via their username).
 */
function analyzeGame(
  game: ParsedGame,
  opponentUsername: string
): {
  queenTradedByCutoff: boolean;
  opponentCaptures: number;
  opponentChecks: number;
  opponentMovedQueenEarly: boolean;
  opponentMoveCount: number;
} {
  const chess = new Chess();
  // In these games, "opponent" (the subject of this profile) is the
  // player identified by opponentUsername. ParsedGame.playerColor refers
  // to whoever fetchGames/parseGame was originally called "for" — when we
  // reuse parseGame here, we call it with forUsername = opponentUsername,
  // so playerColor already IS the opponent's color in each of these games.
  const opponentColor = game.playerColor;

  let queenTradedByCutoff = false;
  let queenTradeCutoffChecked = false;
  let opponentCaptures = 0;
  let opponentChecks = 0;
  let opponentMovedQueenEarly = false;
  let opponentMoveCount = 0;

  for (let ply = 0; ply < game.moves.length; ply++) {
    const san = game.moves[ply];
    const moverColor = ply % 2 === 0 ? "white" : "black";
    let moveResult;
    try {
      moveResult = chess.move(san, { strict: false } as any);
    } catch {
      // Some exported/aborted games contain SAN that cannot be replayed from
      // the initial board. Stop this game's contribution instead of failing
      // the whole opponent-profile request.
      break;
    }
    if (!moveResult) {
      // Malformed/unparseable move — stop analyzing this game rather than
      // guess. Mirrors Step 3's "defensive, don't trust SAN blindly" stance.
      break;
    }

    if (moverColor === opponentColor) {
      opponentMoveCount++;
      if (moveResult.captured) opponentCaptures++;
      if (chess.inCheck()) opponentChecks++;
      if (
        moveResult.piece === "q" &&
        ply < AGGRESSION_EARLY_QUEEN_PLY_CUTOFF
      ) {
        opponentMovedQueenEarly = true;
      }
    }

    if (ply === QUEEN_TRADE_CUTOFF_PLY - 1 || (ply === game.moves.length - 1 && !queenTradeCutoffChecked)) {
      const board = chess.board();
      const queensOnBoard = board
        .flat()
        .filter((sq) => sq && sq.type === "q").length;
      if (queensOnBoard === 0) queenTradedByCutoff = true;
      queenTradeCutoffChecked = true;
    }
  }

  return {
    queenTradedByCutoff,
    opponentCaptures,
    opponentChecks,
    opponentMovedQueenEarly,
    opponentMoveCount,
  };
}

/**
 * Fetches an opponent's recent games and derives OpponentFeatures.
 * Reuses Step 2's fetchGames/parseGame exactly as-is — no new Lichess
 * fetch logic. `forUsername` passed to parseGame is the opponent's own
 * username, so playerColor in the resulting ParsedGame objects already
 * refers to the opponent's color in each game (see analyzeGame above).
 */
export async function extractOpponentFeatures(
  opponentUsername: string,
  max = 20
): Promise<OpponentFeatures> {
  const raw = await fetchGames({
    username: opponentUsername,
    max,
    rated: true,
    perfType: "rapid",
  });
  const games = parseGames(raw, opponentUsername);

  if (games.length === 0) {
    return {
      username: opponentUsername,
      gamesAnalyzed: 0,
      mostCommonOpenings: [],
      queenTradeRate: 0,
      aggressionIndex: 0,
      avgRating: null,
      fetchedAt: Date.now(),
    };
  }

  const openingCounts = new Map<string, { name: string; eco: string; count: number }>();
  let queenTradeCount = 0;
  let totalCaptures = 0;
  let totalChecks = 0;
  let totalMoves = 0;
  let earlyQueenGames = 0;
  let ratingSum = 0;
  let ratingCount = 0;

  for (const game of games) {
    const key = `${game.openingEco ?? "?"}:${game.openingName ?? "Unknown"}`;
    const existing = openingCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      openingCounts.set(key, {
        name: game.openingName ?? "Unknown",
        eco: game.openingEco ?? "?",
        count: 1,
      });
    }

    const result = analyzeGame(game, opponentUsername);
    if (result.queenTradedByCutoff) queenTradeCount++;
    totalCaptures += result.opponentCaptures;
    totalChecks += result.opponentChecks;
    totalMoves += result.opponentMoveCount;
    if (result.opponentMovedQueenEarly) earlyQueenGames++;

    if (typeof game.playerRating === "number") {
      ratingSum += game.playerRating;
      ratingCount++;
    }
  }

  const mostCommonOpenings = Array.from(openingCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Aggression index: blend of per-move capture rate, per-move check rate,
  // and per-game early-queen-move rate, averaged into a single 0-1 score.
  // Weights are a judgment call (not specified anywhere in the original
  // plan) — flagged as adjustable, same as Step 4's flag thresholds were.
  const captureRate = totalMoves > 0 ? totalCaptures / totalMoves : 0;
  const checkRate = totalMoves > 0 ? totalChecks / totalMoves : 0;
  const earlyQueenRate = earlyQueenGames / games.length;
  const aggressionIndex = Math.min(
    1,
    captureRate * 0.4 + checkRate * 0.3 + earlyQueenRate * 0.3
  );

  return {
    username: opponentUsername,
    gamesAnalyzed: games.length,
    mostCommonOpenings,
    queenTradeRate: queenTradeCount / games.length,
    aggressionIndex,
    avgRating: ratingCount > 0 ? ratingSum / ratingCount : null,
    fetchedAt: Date.now(),
  };
}