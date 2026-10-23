import assert from "node:assert/strict";
import { buildCorpusPlan, meetsGameFloor, parseTargetGames, persistCorpus, phaseAt, processTargetsIndependently, selectWinningCorpusGames, validateBigshotConfig, type AnalyzedGame, type BigshotConfig, type SourceGame } from "./lib/bigshotIngestion";
import { MATCHING_CONFIG } from "../config/matching";
import { PHASES, VECTOR_DIMENSIONS, type MatchPhase, type StyleVector } from "../lib/matching/vectorSchema";

async function main(): Promise<void> {
const belowWinPrefilter = selectWinningCorpusGames(Array.from({ length: 349 }, () => ({ result: "win" })));
assert.equal(belowWinPrefilter.skipped, true, "a name with fewer than 350 wins should be skipped before engine work");
assert.equal(belowWinPrefilter.games.length, 0);
const exactlyMinWins = selectWinningCorpusGames(Array.from({ length: 350 }, (_, index) => ({ result: "win", index })));
assert.equal(exactlyMinWins.skipped, false);
assert.equal(exactlyMinWins.games.length, 350, "350 wins is the attempt threshold");
const cappedWins = selectWinningCorpusGames(Array.from({ length: 900 }, (_, index) => ({ result: "win", index })));
assert.equal(cappedWins.games.length, MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS, "larger win corpora must be capped at the configured maximum");
assert.equal(cappedWins.games[0]?.index, 0);
assert.ok(cappedWins.games.at(-1)!.index > 700, "capped selection should span through the source instead of taking only the oldest wins");
assert.equal(selectWinningCorpusGames([
  ...Array.from({ length: 400 }, () => ({ result: "win" })),
  ...Array.from({ length: 200 }, () => ({ result: "loss" })),
]).games.length, 375, "losses must not enter the wins-only ingest set");
const target: BigshotConfig = {
  name: "Synthetic Fixture Player",
  aliases: ["Synthetic Fixture Player"],
  sourceType: "historical_public_domain",
  sourceRef: "synthetic://fixture",
};
const repeatedKnights = Array.from({ length: 12 }, () => ["Nf3", "Nf6", "Ng1", "Ng8"]).flat();
function makePgnSet(label: string, count: number): SourceGame {
  const pgnGames = Array.from({ length: count }, (_, index) => {
    const moves = repeatedKnights.map((san, ply) => ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}. ${san}` : san);
    return `[Event "${label} ${index}"]\n[White "Synthetic Fixture Player"]\n[Black "Fixture Opponent"]\n[Result "1/2-1/2"]\n\n${moves.join(" ")} 1/2-1/2`;
  });
  return { pgn: pgnGames.join("\n\n"), sourceRef: `synthetic://${label}`, sourceType: "historical_public_domain", attribution: null };
}

const belowFloorSource = makePgnSet("below-floor", 3);
const passingSource = makePgnSet("floor-passing", MATCHING_CONFIG.BIGSHOT_MIN_GAMES);
const belowFloorTarget = { ...target, name: "Below Floor Fixture" };
const passingTarget = { ...target, name: "Passing Floor Fixture" };
const missingRefTarget = { ...target, name: "Missing Source Reference", sourceRef: "" };
const badTypeTarget = { ...target, name: "Malformed Source Type", sourceType: "unknown_source" } as unknown as BigshotConfig;

assert.throws(() => validateBigshotConfig(missingRefTarget), /sourceRef is required/);
assert.throws(() => validateBigshotConfig(badTypeTarget), /sourceType is unsupported/);
assert.equal(phaseAt(14), "opening");
assert.equal(phaseAt(15), "middlegame");
assert.equal(phaseAt(39), "middlegame");
assert.equal(phaseAt(40), "endgame");

const syntheticSources = new Map([
  [belowFloorTarget.name, belowFloorSource],
  [passingTarget.name, passingSource],
  [missingRefTarget.name, belowFloorSource],
  [badTypeTarget.name, belowFloorSource],
]);
const skipped: Array<{ name: string; reason: string }> = [];
const prepared = await processTargetsIndependently(
  [belowFloorTarget, passingTarget, missingRefTarget, badTypeTarget],
  async (config) => {
    validateBigshotConfig(config);
    const source = syntheticSources.get(config.name)!;
    const parsed = parseTargetGames(source, config, 0);
    if (!meetsGameFloor(parsed.length)) {
      throw new Error(`${parsed.length} usable games is below the ${MATCHING_CONFIG.BIGSHOT_MIN_GAMES}-game floor`);
    }
    return {
      config,
      games: parsed.map(({ parsed: original, pgn }, gameIndex): AnalyzedGame => {
        const vectors = {} as Record<MatchPhase, StyleVector>;
        const details = {} as Record<MatchPhase, unknown>;
        // Alternating 0 and 2 yields a hand-checkable population mean=1 and stdDev=1.
        const measurement = gameIndex % 2 === 0 ? 0 : 2;
        for (const phase of PHASES) {
          vectors[phase] = Object.fromEntries(VECTOR_DIMENSIONS.map((dimension) => [dimension, measurement])) as StyleVector;
          details[phase] = { fixture: true, gameIndex, phase };
        }
        return { original, pgn, sourceRef: source.sourceRef, sourceType: source.sourceType, attribution: source.attribution, vectors, details };
      }),
    };
  },
  (config, reason) => skipped.push({ name: config.name, reason }),
);

assert.equal(prepared.length, 1, "only floor-clearing, well-formed corpus should proceed");
assert.equal(prepared[0]?.games.length, MATCHING_CONFIG.BIGSHOT_MIN_GAMES);
assert.deepEqual(skipped.map(({ name }) => name), [belowFloorTarget.name, missingRefTarget.name, badTypeTarget.name]);
assert.match(skipped[0]!.reason, /below the 250-game floor/, "below-floor source should be explicitly logged as skipped");
assert.match(skipped[1]!.reason, /sourceRef is required/);
assert.match(skipped[2]!.reason, /sourceType is unsupported/);

const parsed = parseTargetGames(passingSource, passingTarget, 0);
assert.equal(parsed.length, MATCHING_CONFIG.BIGSHOT_MIN_GAMES, "synthetic PGN parser should read all floor-clearing fixtures");
assert.equal(parsed[0]?.parsed.moves.length, 48, "PGN mainlines should retain all legal fixture plies");
const abbreviatedHeader = `[Event "abbreviated"]\n[White "Person,F"]\n[Black "Fixture Opponent"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;
assert.equal(parseTargetGames({ ...belowFloorSource, pgn: abbreviatedHeader }, { ...target, name: "Fixture Person", aliases: ["Fixture Person"] }, 0).length, 1,
  "player recognition should tolerate an abbreviated first-name header with matching surname");

const plan = buildCorpusPlan(prepared);
assert.equal(plan.eligible.length, 1);
assert.equal(plan.rejected.length, 0);
assert.ok(plan.stats);
for (const phase of PHASES) {
  for (const dimension of VECTOR_DIMENSIONS) {
    assert.equal(plan.stats[phase].mean[dimension], 1, `${phase}/${dimension} synthetic mean should equal 1`);
    assert.equal(plan.stats[phase].stdDev[dimension], 1, `${phase}/${dimension} population stdDev should equal 1`);
  }
}

const writes = { calibrations: [] as unknown[], bigshots: [] as unknown[], profiles: [] as unknown[], samples: [] as unknown[] };
const txFake = {
  bigshotVectorCalibration: { upsert: async (args: unknown) => { writes.calibrations.push(args); } },
  bigshot: { upsert: async (args: unknown) => { writes.bigshots.push(args); return { id: "fixture-bigshot-id" }; } },
  bigshotPhaseProfile: {
    deleteMany: async () => undefined,
    create: async (args: unknown) => { writes.profiles.push(args); },
  },
  bigshotSampleGame: {
    deleteMany: async () => undefined,
    createMany: async (args: unknown) => { writes.samples.push(args); },
  },
} as never;
await persistCorpus(txFake, plan.eligible, plan.stats);
assert.equal(writes.calibrations.length, 3, "transaction helper should write one calibration per phase");
assert.equal(writes.bigshots.length, 1, "transaction helper should upsert the bigshot record");
assert.equal(writes.profiles.length, 3, "transaction helper should write all three phase profiles");
assert.equal(writes.samples.length, 3, "transaction helper should write representative samples per phase");
assert.ok(writes.samples.every((entry) => (entry as { data: unknown[] }).data.length === 5));
const calibrationWrites = writes.calibrations.map((entry) => entry as { where: { phase: string }; create: { means: StyleVector; stdDevs: StyleVector; sampleSize: number } });
assert.deepEqual(new Set(calibrationWrites.map((entry) => entry.where.phase)), new Set(PHASES));
assert.ok(calibrationWrites.every(({ create }) => create.sampleSize === MATCHING_CONFIG.BIGSHOT_MIN_GAMES));
assert.ok(calibrationWrites.every(({ create }) => VECTOR_DIMENSIONS.every((dimension) => create.means[dimension] === 1 && create.stdDevs[dimension] === 1)));
const profileVectors = writes.profiles.map((entry) => (entry as { data: { vector: Record<string, number> } }).data.vector);
assert.ok(profileVectors.every((vector) => Object.keys(vector).sort().join(",") === [...VECTOR_DIMENSIONS].sort().join(",")));
assert.ok(profileVectors.every((vector) => Object.values(vector).every(Number.isFinite)));
const persistedSamples = writes.samples.flatMap((entry) => (entry as { data: Array<{ pgn: string; sourceRef: string; phase: string }> }).data);
assert.ok(persistedSamples.every((sample) => sample.pgn.length > 0 && sample.sourceRef === "synthetic://floor-passing"));
assert.deepEqual(new Set(persistedSamples.map((sample) => sample.phase)), new Set(PHASES));

console.log("Synthetic bigshot-ingestion smoke assertions passed.");
}

void main().catch((error) => {
  console.error("Synthetic bigshot-ingestion smoke test failed:", error);
  process.exitCode = 1;
});
