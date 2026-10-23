import assert from "node:assert/strict";
import { computeGameVector } from "../lib/matching/computeGameVector";
import { findNearestBigshots } from "../lib/matching/profileMatcher";
import { PHASES, VECTOR_DIMENSIONS, type StyleVector } from "../lib/matching/vectorSchema";
import { isVanityEvaluationEligible } from "../lib/matching/vanityEligibility";
import type { GameEval, ParsedGame } from "../types";

assert.equal(VECTOR_DIMENSIONS.length, 5);

const game: ParsedGame = {
  id: "fixture-game",
  playerColor: "white",
  opponentUsername: "fixture",
  opponentRating: null,
  playerRating: null,
  moves: ["e4", "d5", "exd5", "Qxd5"],
  clocks: [6000, 6000, 5900, 5900],
  openingName: null,
  openingEco: null,
  result: "win",
  rated: true,
  speed: "classical",
  createdAt: null,
};
const evaluation: GameEval = {
  gameId: game.id,
  evaluatedAt: 1,
  engineVersion: "fixture",
  points: game.moves.map((_, ply) => ({
    ply, cpBefore: 0, cpAfter: ply % 2 === 0 ? -10 : 10,
    mateBefore: null, mateAfter: null, depth: 16, bestMoveUci: null,
  })),
};
const vectors = computeGameVector(game, evaluation, [
  { ply: 2, gamePhase: "opening", color: "white" },
]);
assert.ok(vectors.opening);
assert.deepEqual(Object.keys(vectors.opening!).sort(), [...VECTOR_DIMENSIONS].sort());
assert.equal(vectors.middlegame, null);
assert.equal(vectors.endgame, null);

const self: StyleVector = {
  materialAggression: 0,
  kingSafetyDelta: 1,
  pieceActivityDifferential: -0.2,
  pawnStructureBucket: 2,
  evalVolatility: 0.75,
};
const matches = findNearestBigshots(self, "opening", [
  { bigshotId: "other", phase: "opening", vector: { ...self, evalVolatility: 2 } },
  { bigshotId: "self", phase: "opening", vector: self },
  { bigshotId: "wrong-phase", phase: "endgame", vector: self },
]);
assert.equal(matches[0]?.bigshotId, "self");
assert.equal(matches[0]?.distance, 0);
assert.deepEqual(PHASES, ["opening", "middlegame", "endgame"]);

assert.equal(Object.keys(self).length, 5);
assert.equal(isVanityEvaluationEligible({ rated: true, result: "win", speed: "rapid" }), true);
assert.equal(isVanityEvaluationEligible({ rated: true, result: "win", speed: "bullet" }), true);
assert.equal(isVanityEvaluationEligible({ rated: true, result: "win", speed: "classical" }), true);
assert.equal(isVanityEvaluationEligible({ rated: true, result: "loss", speed: "rapid" }), false);
assert.equal(isVanityEvaluationEligible({ rated: false, result: "win", speed: "rapid" }), false);
console.log("Matching unit checks passed.");
