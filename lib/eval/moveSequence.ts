import { Chess } from "chess.js";
import type { EvalPoint } from "@/types";
import type { EvalResult } from "./stockfishEngine";

export interface EvalSequenceCheckpoint {
  points: EvalPoint[];
  evalBefore: EvalResult;
}

/** Pure SAN/evaluation sequence shared by browser and server Stockfish callers. */
export async function evaluateMoveSequenceWith(
  moves: string[],
  evaluatePosition: (fen: string) => Promise<EvalResult>,
  onPlyComplete?: (points: EvalPoint[], evalBefore: EvalResult) => Promise<void>,
  checkpoint?: Pick<EvalSequenceCheckpoint, "points" | "evalBefore">,
): Promise<EvalPoint[]> {
  const chess = new Chess();
  const points = checkpoint?.points.map((point) => ({ ...point })) ?? [];
  for (let ply = 0; ply < points.length; ply++) {
    const move = chess.move(moves[ply]);
    if (!move) throw new Error(`Invalid SAN "${moves[ply]}" at ply ${ply}`);
  }
  let evalBefore = checkpoint?.evalBefore ?? await evaluatePosition(chess.fen());

  for (let ply = points.length; ply < moves.length; ply++) {
    const move = chess.move(moves[ply]);
    if (!move) throw new Error(`Invalid SAN "${moves[ply]}" at ply ${ply}`);
    const evalAfter = await evaluatePosition(chess.fen());
    points.push({
      ply,
      cpBefore: evalBefore.cp,
      cpAfter: evalAfter.cp !== null ? -evalAfter.cp : null,
      mateBefore: evalBefore.mate,
      mateAfter: evalAfter.mate !== null ? -evalAfter.mate : null,
      depth: Math.min(evalBefore.depth, evalAfter.depth),
      bestMoveUci: evalBefore.bestMoveUci,
    });
    evalBefore = evalAfter;
    await onPlyComplete?.(points, evalBefore);
  }
  return points;
}
