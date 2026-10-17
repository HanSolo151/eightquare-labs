import type { GameEval } from "../types";
import { evaluateMoveSequence, inspectGameEval, normalizeEvalPoint } from "../lib/eval/evalCache";
import { parseStockfishInfoLine } from "../lib/eval/stockfishEngine";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`PASS: ${message}`);
}

const cpParsed = parseStockfishInfoLine("info depth 14 score cp 125 nodes 1000", {
  cp: null,
  mate: null,
  depth: 0,
  bestMoveUci: null,
});
assert(cpParsed.cp === 125, "UCI cp score stays in centipawns (125 means +1.25 pawns)");
assert(cpParsed.depth === 14, "UCI search depth is retained");

const mateParsed = parseStockfishInfoLine("info depth 16 score mate -3", cpParsed);
assert(mateParsed.cp === null && mateParsed.mate === -3, "mate score is not misrepresented as centipawns");

const whitePoint = normalizeEvalPoint(
  0,
  { cp: 80, mate: null, depth: 14, bestMoveUci: null },
  { cp: -125, mate: null, depth: 16, bestMoveUci: null }
);
assert(whitePoint.cpBefore === 80 && whitePoint.cpAfter === 125, "White move after-score is converted from Black POV to White POV");
assert(whitePoint.depth === 14, "per-ply confidence depth uses the shallower of before and after searches");
const whiteMatePoint = normalizeEvalPoint(
  0,
  { cp: null, mate: 3, depth: 14, bestMoveUci: null },
  { cp: null, mate: -2, depth: 16, bestMoveUci: null }
);
assert(whiteMatePoint.mateBefore === 3 && whiteMatePoint.mateAfter === 2, "mate distance is converted to the mover's POV");

const blackPoint = normalizeEvalPoint(
  1,
  { cp: 60, mate: null, depth: 14, bestMoveUci: null },
  { cp: 190, mate: null, depth: 15, bestMoveUci: null }
);
assert(blackPoint.cpBefore === 60 && blackPoint.cpAfter === -190, "Black move after-score is converted from White POV to Black POV");
const blackMatePoint = normalizeEvalPoint(
  1,
  { cp: null, mate: 4, depth: 14, bestMoveUci: null },
  { cp: null, mate: -1, depth: 16, bestMoveUci: null }
);
assert(blackMatePoint.mateBefore === 4 && blackMatePoint.mateAfter === 1, "Black mate distance is also stored from the mover's POV");

const complete: GameEval = {
  gameId: "quality-test",
  points: [whitePoint, blackPoint],
  evaluatedAt: Date.now(),
  engineVersion: "test",
};
const completeReport = inspectGameEval(complete, 2);
assert(completeReport.structurallyComplete, "one evaluation point exists for every expected ply");
assert(completeReport.cpComparablePlies.length === 2, "both normal-score plies are CP-comparable");

const withMate: GameEval = {
  ...complete,
  points: [
    { ...whitePoint, cpAfter: null, mateAfter: -3 },
    blackPoint,
  ],
};
const mateReport = inspectGameEval(withMate, 2);
assert(mateReport.mateOnlyPlies.includes(0), "mate-only ply is reported separately from malformed scores");
assert(mateReport.cpComparablePlies.length === 1, "mate-only ply is excluded from CP-delta coverage");

const incomplete: GameEval = {
  ...complete,
  points: [{ ...whitePoint, depth: 0 }, { ...blackPoint, cpAfter: null, mateAfter: null }],
};
const incompleteReport = inspectGameEval(incomplete, 3);
assert(incompleteReport.missingPlies[0] === 2, "missing ply index is identified");
assert(incompleteReport.invalidDepthPlies.includes(0), "zero-depth evaluation is reported");
assert(incompleteReport.invalidScorePlies.includes(1), "a ply with no CP or mate score is reported");

const duplicate: GameEval = { ...complete, points: [whitePoint, blackPoint, blackPoint] };
const duplicateReport = inspectGameEval(duplicate, 2);
assert(duplicateReport.duplicatePlies.includes(1), "duplicate ply records are reported");

async function testMoveSequence(): Promise<void> {
  const rawSequenceScores = [10, -20, 30, -40];
  let sequenceSearches = 0;
  const sequencePoints = await evaluateMoveSequence(["e4", "e5", "Nf3"], async () => ({
    cp: rawSequenceScores[sequenceSearches++],
    mate: null,
    depth: 14,
    bestMoveUci: null,
  }));
  assert(sequenceSearches === 4, "N moves perform N+1 searches because adjacent plies reuse the shared position");
  assert(sequencePoints.length === 3, "the SAN evaluation loop yields exactly one EvalPoint per move ply");
  assert(
    sequencePoints[0].cpBefore === 10 && sequencePoints[0].cpAfter === 20 &&
    sequencePoints[1].cpBefore === -20 && sequencePoints[1].cpAfter === -30 &&
    sequencePoints[2].cpBefore === 30 && sequencePoints[2].cpAfter === 40,
    "full White/Black/White sequence has mover-relative CP signs"
  );
  assert(
    inspectGameEval({ ...complete, points: sequencePoints }, 3).cpComparablePlies.length === 3,
    "all sequence plies are usable by the centipawn-delta flag rule"
  );

  let invalidSanRejected = false;
  try {
    await evaluateMoveSequence(["e4", "not-a-move"], async () => ({ cp: 0, mate: null, depth: 14, bestMoveUci: null }));
  } catch {
    invalidSanRejected = true;
  }
  assert(invalidSanRejected, "an illegal SAN halts evaluation explicitly instead of returning a partial success");
}

void testMoveSequence().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
