import assert from "node:assert/strict";
import { styleAdjustedProbabilities } from "@/lib/maia/rerank";
import type { OpponentProfile } from "@/lib/profile/opponentStyleProfile";

const profile: OpponentProfile = {
  aggression: 1,
  sacrifice: 0,
  pragmatism: 0,
  theory: 0,
  gamesAnalyzed: 12,
  movesAnalyzed: 200,
};
const e4Base = Math.exp(2) / (Math.exp(2) + Math.exp(1));
const checkBase = Math.exp(1) / (Math.exp(2) + Math.exp(1));
const adjusted = styleAdjustedProbabilities([
  { san: "e4", probability: e4Base, isCheck: false, isCapture: false, isQueenCapture: false, isQuiet: true },
  { san: "Qh5+", probability: checkBase, isCheck: true, isCapture: false, isQueenCapture: false, isQuiet: false },
], profile);

const e4 = adjusted.find((move) => move.san === "e4")!;
const check = adjusted.find((move) => move.san === "Qh5+")!;
assert.ok(check.probability > checkBase, "aggression should increase the checking move probability");
assert.ok(check.probability / checkBase > 1.2, "the checking move should receive a material relative boost");
assert.ok(e4.probability < e4Base, "normalization should reduce the quiet move probability");
assert.ok(Math.abs(adjusted.reduce((sum, move) => sum + move.probability, 0) - 1) < 1e-10);
console.log("Reranker aggression probability check passed.");
