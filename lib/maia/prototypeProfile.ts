import { Chess } from "chess.js";
import type { ParsedGame } from "@/types";
import { mirrorUci } from "./boardToTensor";

export interface PrototypeMoveProfile {
  games: string[][];
  invalidGames: number;
}

export function buildPrototypeMoveProfile(
  games: ParsedGame[],
  maximumGames = 50,
): PrototypeMoveProfile {
  if (!Number.isInteger(maximumGames) || maximumGames < 1) {
    throw new RangeError("maximumGames must be a positive integer.");
  }

  const profile: string[][] = [];
  let invalidGames = 0;
  for (const game of games.slice(0, maximumGames)) {
    const board = new Chess();
    const playerTurn = game.playerColor === "white" ? "w" : "b";
    const moves: string[] = [];
    let valid = true;
    for (const san of game.moves) {
      const isPlayerMove = board.turn() === playerTurn;
      try {
        const move = board.move(san);
        if (isPlayerMove) {
          const uci = move.from + move.to + (move.promotion ?? "");
          moves.push(game.playerColor === "black" ? mirrorUci(uci) : uci);
        }
      } catch {
        invalidGames++;
        valid = false;
        break;
      }
    }
    if (valid && moves.length > 0) profile.push(moves);
  }
  return { games: profile, invalidGames };
}
