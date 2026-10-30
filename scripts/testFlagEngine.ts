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

function point(ply: number, cpBefore: number | null, cpAfter: number | null, mateBefore: number | null = null, mateAfter: number | null = null): EvalPoint {
  return { ply, cpBefore, cpAfter, mateBefore, mateAfter, depth: 16, bestMoveUci: null };
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

function flagForLoss(cpLoss: number) {
  const after = 500 - cpLoss;
  return flagMoves(
    [feature(0, "white"), feature(1, "black")], profile, weaknesses,
    gameEval([point(0, 500, after), point(1, -after, -after)]), "white",
  )[0];
}
assert(flagForLoss(100)?.severity === "medium", "a 1.0-pawn unrecovered loss is medium severity");
assert(flagForLoss(200)?.severity === "medium", "a 2.0-pawn unrecovered loss remains medium severity");
assert(flagForLoss(201)?.severity === "high", "an unrecovered loss above 2.0 pawns is high severity");

console.log("All flag-engine checks passed.");
