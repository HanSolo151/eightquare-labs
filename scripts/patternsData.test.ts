import assert from "node:assert/strict";
import test from "node:test";
import { buildBiasData } from "@/lib/bias/getBiasData";
import { heatmapDrilldownHref, openingDrilldownHref, weaknessPatternGamesHref, weaknessPatternTagHref } from "@/lib/patterns/getPatternsData";
import type { SquareBias } from "@/lib/bias/updateBiasProfile";

test("bias data exposes square-backed rank, file, and diagonal aggregates at threshold", () => {
  const squareBias: SquareBias = {
    a1: { moveCount: 12, flaggedCount: 3, totalCpLoss: 300, clockDataCount: 10, under30Count: 4, flagTypeCounts: { collapse: 2, time_paradox: 1 } },
    a2: { moveCount: 10, flaggedCount: 2, totalCpLoss: 200, clockDataCount: 8, under30Count: 2, flagTypeCounts: { collapse: 2 } },
    b1: { moveCount: 10, flaggedCount: 1, totalCpLoss: 100, clockDataCount: 9, under30Count: 3, flagTypeCounts: { tilt_cascade: 1 } },
  };

  const bias = buildBiasData(squareBias, 20);
  assert.equal(bias.meetsThreshold, true);
  assert.ok(bias.axes.ranks.length > 0);
  assert.ok(bias.axes.files.length > 0);
  assert.ok(bias.axes.diagonals.length > 0);
  assert.deepEqual(bias, buildBiasData(squareBias, 20));
});

test("bias data stays unavailable below the profile sample threshold", () => {
  const bias = buildBiasData({}, 7);
  assert.equal(bias.meetsThreshold, false);
  assert.equal(bias.sampleSize, 7);
  assert.deepEqual(bias.axes, { ranks: [], files: [], diagonals: [] });
});

test("opening ECO produces the existing drilldown URL; missing ECO remains non-interactive", () => {
  assert.equal(openingDrilldownHref("B07"), "/dashboard/openings/B07");
  assert.equal(openingDrilldownHref(null), null);
});

test("heatmap drilldown carries phase and severity filters", () => {
  assert.equal(heatmapDrilldownHref("middlegame", "high"), "/dashboard/games?phase=middlegame&severity=high");
});

test("weakness drilldown preserves exact game/ply pairs and caps the URL at 50 occurrences", () => {
  const occurrences = Array.from({ length: 60 }, (_, i) => ({ gameId: `game${i % 3}`, ply: i }));
  const href = weaknessPatternGamesHref(occurrences);
  assert.ok(href);
  const params = new URLSearchParams(href.split("?")[1]);
  assert.equal(params.get("occurrenceCount"), "60");
  assert.deepEqual(params.get("gameIds")?.split(","), ["game1", "game2", "game0"]);
  const linked = params.get("occurrences")?.split(",").map((token) => {
    const [gameId, ply] = token.split(":");
    return { gameId, ply: Number(ply) };
  });
  assert.equal(linked?.length, 50);
  assert.deepEqual(linked?.[0], { gameId: "game1", ply: 10 });
  assert.deepEqual(linked?.[49], { gameId: "game2", ply: 59 });
});

test("weakness phase tags link to their source games with the matching phase filter", () => {
  assert.equal(
    weaknessPatternTagHref("middlegame", [{ gameId: "abc123", ply: 18 }]),
    "/dashboard/games?gameIds=abc123&occurrences=abc123%3A18&occurrenceCount=1&phase=middlegame"
  );
  assert.equal(weaknessPatternTagHref("fork", [{ gameId: "abc123", ply: 18 }]), null);
  assert.equal(weaknessPatternTagHref("opening", []), null);
});
