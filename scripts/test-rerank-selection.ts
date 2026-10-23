import assert from "node:assert/strict";
import { selectRerankCandidates } from "../lib/matching/rerankAndSelect";

const now = new Date("2026-10-23T00:00:00.000Z");
const candidate = (id: string, distance: number, soundness: "sound" | "unsound_lucky" | "unverified" = "sound") => ({
  id,
  matchedBigshotId: `bigshot-${id}`,
  matchDistance: distance,
  motifMatch: false,
  soundness,
  sampleSize: 250,
  createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
});

const five = [candidate("a", 0.5), candidate("b", 0.8), candidate("c", 0.9), candidate("d", 1), candidate("e", 1.1)];
const noSends = selectRerankCandidates(five, 0, new Set(), now);
assert.equal(noSends.selected.length, 2);
assert.deepEqual(noSends.selected.map((item) => item.id), ["a", "b"]);
assert.equal(selectRerankCandidates(five, 2, new Set(), now).selected.length, 0);
assert.equal(selectRerankCandidates(five, 1, new Set(), now).selected.length, 1);

const adjusted = selectRerankCandidates([
  { ...candidate("motif", 0.5), motifMatch: true },
  candidate("repeat", 0.5),
], 0, new Set(["bigshot-repeat"]), now);
assert.equal(adjusted.selected[0]?.id, "motif", "motif and recent-repeat adjustments should affect ranking");

const expired = selectRerankCandidates([candidate("old", 0.1)], 0, new Set(), new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
assert.deepEqual(expired.expiredIds, ["old"]);
assert.equal(expired.selected.length, 0);

console.log("Rerank selection checks passed.");
