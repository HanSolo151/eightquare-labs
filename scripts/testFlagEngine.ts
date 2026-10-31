import type { EvalPoint, GameEval, MoveFeature, PlayerProfile, WeaknessProfile } from "../types";
import { checkCausality } from "../lib/flags/causality";
import { flagMoves, resolveCpLoss } from "../lib/flags/flagEngine";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`PASS: ${message}`);
}

const profile: PlayerProfile = {
  username: "test-player", gamesAnalyzed: 1,
  avgMoveTimeSecByPhase: { opening: 10, middlegame: 10, endgame: 10 },
  premoveRate: 0, mostCommonOpenings: [], avgOpponentRating: 1500,
};
const weaknesses: WeaknessProfile = {
  username: "test-player", patterns: [], evaluatedGameIds: [], gamesEvaluated: 1,
  gamesFetched: 1, confidence: "low", builtAt: 0,
};

function point(ply: number, cpBefore: number | null, cpAfter: number | null, mateBefore: number | null = null, mateAfter: number | null = null, depth = 16): EvalPoint {
  return { ply, cpBefore, cpAfter, mateBefore, mateAfter, depth, bestMoveUci: null };
}
function gameEval(points: EvalPoint[]): GameEval {
  return { gameId: "g", points, evaluatedAt: 0, engineVersion: "test" };
}
function feature(ply: number, color: "white" | "black", overrides: Partial<MoveFeature> = {}): MoveFeature {
  return {
    gameId: "g", ply, moveNumber: Math.floor(ply / 2) + 1, color, san: "e4",
    timeSpentSec: null, clockRemainingSec: null, likelyPremove: false, isSnapDecision: false,
    isCapture: false, isCheck: false, isForcing: false, gamePhase: "middlegame", ...overrides,
  };
}

// Player's score starts +3.00, drops to +1.00, and never returns near +3.00.
const unrecovered = gameEval([point(0, 300, 100), point(1, -100, -100)]);
const whiteFlag = flagMoves([feature(0, "white"), feature(1, "black")], profile, weaknesses, unrecovered, "white");
assert(whiteFlag.length === 1 && whiteFlag[0].flagType === "decision_error" && whiteFlag[0].cpLoss === 200,
  "a lasting 200cp loss is flagged regardless of missing clock/profile timing data");
assert(whiteFlag[0].causality.heldToEnd && whiteFlag[0].causality.plyChecked === 1,
  "causality reports the final evaluated ply actually checked");

const recovered = gameEval([
  point(0, 300, 100), point(1, -100, -100), point(2, 100, 260), point(3, -260, -260),
]);
assert(!checkCausality(recovered, 0, "white").heldToEnd,
  "recovery means returning within 50cp of the pre-move evaluation, not merely reaching parity");
assert(flagMoves([feature(0, "white"), feature(1, "black"), feature(2, "white"), feature(3, "black")], profile, weaknesses, recovered, "white").length === 0,
  "a position that genuinely recovers the lost evaluation is not flagged as unresolved");
assert(flagMoves([feature(0, "white"), feature(1, "black")], profile, weaknesses,
  gameEval([point(0, 300, 100)]), "white").length === 0,
  "partial game evaluations do not produce end-of-game conclusions");

const blackLoss = gameEval([point(0, -100, -100), point(1, 300, 100), point(2, -100, -100)]);
const blackFlag = flagMoves([feature(0, "white"), feature(1, "black"), feature(2, "white")], profile, weaknesses, blackLoss, "black");
assert(blackFlag.length === 1 && blackFlag[0].cpLoss === 200,
  "Black's mover-relative evaluations are handled with the same player-relative recovery rule");

const premoveBlunder = flagMoves(
  [feature(0, "white", { likelyPremove: true, timeSpentSec: 0.2, clockRemainingSec: 20 }), feature(1, "black")],
  profile, weaknesses, unrecovered, "white",
);
assert(premoveBlunder.length === 1,
  "premove timing does not hide an objectively large unrecovered evaluation loss");

const cpToMate = resolveCpLoss(point(0, 100, null, null, -3));
assert(cpToMate?.evalConfidence === "mate_only" && (cpToMate.cpLoss ?? 0) > 10_000,
  "a cp-to-forced-mate loss is scored and marked as mate-backed");
const mateToCp = resolveCpLoss(point(0, null, 100, 3, null));
assert(mateToCp?.evalConfidence === "mate_only" && (mateToCp.cpLoss ?? 0) > 9_000,
  "losing a forced mate is detected when the resulting position returns to a cp score");
const mateDistance = resolveCpLoss(point(0, null, null, 3, 8));
assert(mateDistance?.cpLoss === 5,
  "mate-distance changes preserve direction and distance without pretending to be ordinary cp confidence");

const cascade = gameEval([
  point(0, 500, 400), point(1, -400, -400),
  point(2, 400, 250), point(3, -250, -250),
]);
const cascadeFlags = flagMoves(
  [feature(0, "white"), feature(1, "black"), feature(2, "white"), feature(3, "black")], profile, weaknesses, cascade, "white",
);
assert(cascadeFlags.length === 1 && cascadeFlags[0].flagType === "evaluation_cascade" && cascadeFlags[0].cpLoss === 250,
  "a lasting multi-move decline produces one cascade summary instead of duplicate individual flags");

function flagForLoss(cpLoss: number, depth = 16) {
  const after = 500 - cpLoss;
  return flagMoves(
    [feature(0, "white"), feature(1, "black")], profile, weaknesses,
    gameEval([point(0, 500, after, null, null, depth), point(1, -after, -after, null, null, depth)]), "white",
  )[0];
}
assert(flagForLoss(100)?.severity === "low", "a 1.0-pawn loss remains a flag but is low severity below the 1.5-pawn medium floor");
assert(flagForLoss(149)?.severity === "low", "a loss below 1.5 pawns is low severity");
assert(!flagForLoss(100, 10) && !flagForLoss(149, 10),
  "100-149cp flags are suppressed below depth 16");
assert(flagForLoss(150, 10)?.severity === "medium",
  "150cp flags retain the degraded-depth path");
assert(flagForLoss(150)?.severity === "medium", "a 1.5-pawn unrecovered loss is medium severity");
assert(flagForLoss(200)?.severity === "medium", "a 2.0-pawn unrecovered loss remains medium severity");
assert(flagForLoss(201)?.severity === "high", "an unrecovered loss above 2.0 pawns is high severity");

assert(resolveCpLoss({ ...point(0, 200, 100), depth: 7 }) === null,
  "depth below 8 is unusable for move-loss resolution");
assert(resolveCpLoss({ ...point(0, 200, 100), depth: 8 })?.evalConfidence === "degraded",
  "depth 8 is accepted but marked degraded");
assert(resolveCpLoss({ ...point(0, 200, 100), depth: 9 })?.evalConfidence === "degraded",
  "depth 9 is accepted but marked degraded");
assert(resolveCpLoss({ ...point(0, 200, 100), depth: 10 })?.evalConfidence === "degraded",
  "depth 10 remains below the configured depth-16 target and is marked degraded");
assert(resolveCpLoss({ ...point(0, 200, 100), depth: 15 })?.evalConfidence === "degraded",
  "depth 15 is marked degraded below the configured depth-16 target");
assert(resolveCpLoss({ ...point(0, 200, 100), depth: 16 })?.evalConfidence === "full",
  "depth 16 meets the full-confidence target");
assert(resolveCpLoss({ ...point(0, 200, null, null, 3), depth: 10 })?.evalConfidence === "degraded_mate_only",
  "shallow mate-backed loss retains its mate-only label and degraded-depth caution");

const exactRecovery = gameEval([point(0, 500, 400), point(1, -400, -450)]);
assert(!checkCausality(exactRecovery, 0, "white").heldToEnd &&
  checkCausality(exactRecovery, 0, "white").recoveredAtPly === 1,
  "recovery exactly at the 50cp tolerance is considered recovered");
const outsideRecovery = gameEval([point(0, 500, 400), point(1, -400, -449)]);
assert(checkCausality(outsideRecovery, 0, "white").heldToEnd,
  "recovery 51cp below baseline is not considered recovered");

const timedFeature = feature(0, "white", { timeSpentSec: 0.1, likelyPremove: true, isForcing: true });
const timedFlags = flagMoves([timedFeature, feature(1, "black")], profile, weaknesses, unrecovered, "white");
assert(timedFlags.length === 1 && timedFlags[0].timeRatio === 1 &&
  timedFlags[0].phaseAvgSec === 0 && timedFlags[0].styleDeviationScore === 0,
  "clock speed is display-only: premove timing does not change eligibility or add a timing bonus");

const noEvalLoss = flagMoves([feature(0, "white"), feature(1, "black")], profile, weaknesses,
  gameEval([point(0, 99, 0), point(1, 0, 0)]), "white");
assert(noEvalLoss.length === 0, "a 99cp loss is below the 100cp minimum");

const brokenSequence = gameEval([point(0, 500, 400), point(2, 400, 200)]);
assert(flagMoves([feature(0, "white"), feature(1, "black"), feature(2, "white")], profile, weaknesses,
  brokenSequence, "white").length === 0,
  "a missing evaluation ply prevents a causality conclusion");

const recoveryBeforeLaterCascade = gameEval([
  point(0, 500, 300), point(1, -300, -500),
  point(2, 500, 440), point(3, -440, -440),
  point(4, 440, 250), point(5, -250, -250),
]);
const recoveryBeforeLaterFlags = flagMoves(
  [feature(0, "white"), feature(1, "black"), feature(2, "white"), feature(3, "black"), feature(4, "white"), feature(5, "black")],
  profile, weaknesses, recoveryBeforeLaterCascade, "white",
);
assert(!recoveryBeforeLaterFlags.some((flag) => flag.flagType === "evaluation_cascade") &&
  recoveryBeforeLaterFlags.some((flag) => flag.flagType === "decision_error" && flag.ply === 4),
  "diagnostic limitation: a recovered early loss can consume a later qualifying cascade run");

console.log("All flag-engine checks passed.");
