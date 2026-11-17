import { Chess } from "chess.js";
import type { EvalPoint } from "@/types";
import type { EvalResult } from "./stockfishEngine";

export interface EvalSequenceCheckpoint {
  points: EvalPoint[];
  evalBefore: EvalResult;
}

export function normalizeEvalPoint(ply: number, before: EvalResult, after: EvalResult): EvalPoint {
  const isTerminalAfterMove = after.depth === 0 &&
    after.bestMoveUci === null &&
    ((after.cp === 0 && after.mate === null) || (after.cp === null && after.mate === 0));

  return {
    ply,
    cpBefore: before.cp,
    cpAfter: after.cp !== null ? -after.cp : null,
    mateBefore: before.mate,
    mateAfter: after.mate !== null ? -after.mate : null,
    depth: isTerminalAfterMove ? before.depth : Math.min(before.depth, after.depth),
    bestMoveUci: before.bestMoveUci,
  };
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
    points.push(normalizeEvalPoint(ply, evalBefore, evalAfter));
    evalBefore = evalAfter;
    await onPlyComplete?.(points, evalBefore);
  }
  return points;
}
