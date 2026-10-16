import { Chess } from "chess.js";
import { evalFenMultiPv } from "../eval/stockfishEngine";
import type { PivotMoveAttribution } from "@/types";

const PIVOT_TOP_N = 3;

function lineCp(line: { cp: number | null; mate: number | null }): number {
  if (line.cp !== null) return line.cp;
  if (line.mate !== null) return Math.sign(line.mate) * 10000;
  return 0;
}

export async function computePivotMove(
  positionBeforePivot: Chess,
  pivotPly: number,
  pivotSan: string
): Promise<PivotMoveAttribution | null> {
  const fenBefore = positionBeforePivot.fen();
  const repliesBefore = positionBeforePivot.moves().length;
  const chessAfter = new Chess(fenBefore);
  const moveResult = chessAfter.move(pivotSan);
  if (!moveResult) return null;

  const complexityDelta = chessAfter.moves().length - repliesBefore;
  let topLines: Awaited<ReturnType<typeof evalFenMultiPv>>;
  try {
    topLines = await evalFenMultiPv(fenBefore, PIVOT_TOP_N);
  } catch (err) {
    console.error("Pivot-move multiPV search failed:", err);
    return { ply: pivotPly, san: pivotSan, evalShiftCp: 0, wasTopEngineChoice: false, wasInTopN: false, complexityDelta };
  }
  if (topLines.length === 0) {
    return { ply: pivotPly, san: pivotSan, evalShiftCp: 0, wasTopEngineChoice: false, wasInTopN: false, complexityDelta };
  }

  const playedUci = moveResult.from + moveResult.to + (moveResult.promotion ?? "");
  const matchIndex = topLines.findIndex((line) => line.uci === playedUci);
  const bestLineCp = lineCp(topLines[0]);
  const evalShiftCp = matchIndex !== -1 ? bestLineCp - lineCp(topLines[matchIndex]) : 0;
  return {
    ply: pivotPly,
    san: pivotSan,
    evalShiftCp,
    wasTopEngineChoice: matchIndex === 0,
    wasInTopN: matchIndex !== -1,
    complexityDelta,
  };
}
