import { Chess } from "chess.js";
import type { EvalPoint, GameEval } from "@/types";
import type { ServerEvalResult } from "./stockfishCli";
import { evaluateMoveSequenceWith } from "./moveSequence";

export interface ServerEvalCheckpoint {
  points: EvalPoint[];
  evalBefore: ServerEvalResult;
}

export async function evaluateServerGame(
  gameId: string,
  moves: string[],
  evaluatePosition: (fen: string) => Promise<ServerEvalResult>,
  checkpoint?: ServerEvalCheckpoint,
  onPlyComplete?: (progress: ServerEvalCheckpoint) => Promise<void>,
): Promise<GameEval> {
  const points = await evaluateMoveSequenceWith(moves, evaluatePosition, async (savedPoints, evalBefore) => {
    await onPlyComplete?.({ points: savedPoints.map((point) => ({ ...point })), evalBefore });
  }, checkpoint);
  const result: GameEval = {
    gameId,
    points,
    evaluatedAt: Date.now(),
    engineVersion: "stockfish-19-lite-single-depth16-v2",
  };
  // Ensure the saved evaluation corresponds to the entire synced mainline.
  const replay = new Chess();
  for (const move of moves) {
    if (!replay.move(move)) throw new Error(`Invalid SAN in synced game ${gameId}`);
  }
  return result;
}
