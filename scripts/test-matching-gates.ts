import assert from "node:assert/strict";
import { applyVarietyGate, classifySoundness, gateBigshotMatch, passesCorpusFloor, passesResultGate } from "../lib/matching/gates";
import type { BigshotMatch } from "../lib/matching/profileMatcher";
import type { MatchPhase } from "../lib/matching/vectorSchema";

const phase: MatchPhase = "middlegame";
const matches: BigshotMatch[] = [
  { bigshotId: "tal", distance: 1, motifMatch: false },
  { bigshotId: "capablanca", distance: 1.1, motifMatch: true },
  { bigshotId: "fischer", distance: 1.3, motifMatch: false },
];
const profiles = {
  tal: { phase, sampleSize: 300 },
  capablanca: { phase, sampleSize: 300 },
  fischer: { phase, sampleSize: 249 },
};
const now = new Date("2026-10-23T00:00:00.000Z");

assert.equal(passesResultGate("win"), true, "wins should pass the result gate");
assert.equal(passesResultGate("loss"), false, "losses should fail the result gate");
assert.equal(passesResultGate("draw"), false, "draws should be excluded by default");

assert.equal(classifySoundness(2, 0.4), "unsound_lucky", "a >1.5 pawn drop should be marked unsound_lucky");
assert.equal(classifySoundness(2, 0.5), "sound", "a drop equal to the threshold should remain sound");
assert.equal(classifySoundness(null, 0.5), "unverified", "missing evaluations should remain unverified");

assert.equal(passesCorpusFloor(profiles.tal, phase), true, "a corpus at the floor should pass");
assert.equal(passesCorpusFloor(profiles.fischer, phase), false, "a corpus below the floor should fail");
assert.equal(passesCorpusFloor({ phase: "opening", sampleSize: 300 }, phase), false, "a profile from another phase should fail");

const recent = [{ matchedBigshotId: "tal", createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) }];
const variety = applyVarietyGate(matches, phase, profiles, recent, now);
assert.deepEqual(variety, { pass: true, value: matches[1] }, "a close, corpus-qualified alternative should be selected after a recent repeat");
const distantAlternative = applyVarietyGate([
  matches[0], { ...matches[1], distance: 1.16 }, matches[2],
], phase, profiles, recent, now);
assert.deepEqual(distantAlternative, { pass: true, value: matches[0] }, "a candidate outside the variety margin should not replace the top match");

let matcherCalled = false;
const excluded = gateBigshotMatch({
  result: "loss", evalBefore: 1, evalAfter: 0, phase,
  findMatches: () => { matcherCalled = true; return matches; },
  profilesByBigshotId: profiles, recentMoments: [], now,
});
assert.deepEqual(excluded, { pass: false, reason: "result_excluded" }, "losses should short-circuit before matching");
assert.equal(matcherCalled, false, "the matcher must not run after the result gate fails");

const failedCorpus = gateBigshotMatch({
  result: "win", evalBefore: 1, evalAfter: 0, phase,
  findMatches: () => [matches[2]], profilesByBigshotId: profiles, recentMoments: [], now,
});
assert.deepEqual(failedCorpus, { pass: false, reason: "corpus_below_floor" }, "an under-floor matched profile should be rejected");

const accepted = gateBigshotMatch({
  result: "win", evalBefore: 2, evalAfter: 0.4, phase,
  findMatches: () => matches, profilesByBigshotId: profiles, recentMoments: recent, now,
});
assert.deepEqual(accepted, { pass: true, value: { match: matches[1], soundness: "unsound_lucky" } });

console.log("Matching gate checks passed.");
