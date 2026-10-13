// scripts/testRerank.ts
//
// Standalone test for Step 9's rerankMoves(), same pattern as
// testFetchGames.ts / testExtractFeatures.ts / testFlagEngine.ts /
// testOpponentFeatures.ts — hardcoded inputs, no network, no browser,
// no worker. Run via: npx tsx scripts/testRerank.ts
//
// This does NOT validate against a real ONNX session or real Lichess
// data — it validates rerankMoves()'s own logic in isolation:
// - legality filtering (illegal vocab entries excluded)
// - renormalization (both baseProbability and adjustedProbability sum to 1)
// - boost direction (aggressive opponent -> captures/checks ranked higher;
//   passive opponent -> they shouldn't)
// - queen-trade boost direction, independently of the aggression boost
// - the checkmate/stalemate (zero legal moves) edge case
//
// Real end-to-end validation (real logits from the real worker, real FEN
// mid-game, real OpponentFeatures from a live account) still needs to
// happen in-browser once Step 10 actually calls this function — same
// caveat Step 7's Node script had versus its live /debug test.

import { rerankMoves } from "../lib/maia/rerank";
import { loadMoveVocab } from "../lib/maia/moveVocab";
import type { OpponentFeatures } from "../lib/lichess/opponentFeatures";

// loadMoveVocab() does a `fetch("/data/move_vocab.json")`, which assumes a
// browser/Next.js runtime with that path servable. Under plain `tsx` (no
// Next.js dev server running) that fetch will fail. Patching global.fetch
// here to read the file straight off disk instead, so this script can run
// standalone. If this patch ever goes stale (e.g. moveVocab.ts changes how
// it fetches), this script will fail loudly rather than silently pass with
// fabricated data — that's intentional, not a workaround to "fix" quietly.
import fs from "node:fs/promises";
import path from "node:path";


import { fileURLToPath } from "node:url";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error - minimal fetch shim, not a full implementation
global.fetch = async (url: string) => {
  if (url !== "/data/move_vocab.json") {
    throw new Error(`testRerank.ts fetch shim only knows /data/move_vocab.json, got: ${url}`);
  }
  const filePath = path.join(__dirname, "..", "public", "data", "move_vocab.json");
  
  const raw = await fs.readFile(filePath, "utf-8");
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(raw),
  };
};

function fakeOpponent(overrides: Partial<OpponentFeatures>): OpponentFeatures {
  return {
    username: "fake-opponent",
    gamesAnalyzed: 20,
    mostCommonOpenings: [],
    queenTradeRate: 0.5,
    aggressionIndex: 0.35,
    avgRating: 1800,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

// Builds a fake logitsMaia array (length 1880) where a specific set of UCI
// moves get a deliberately high logit and everything else gets a low,
// roughly-flat logit. This lets us assert on WHICH moves end up on top
// without needing a real model.
async function fakeLogits(boostedUci: string[], boostValue = 8): Promise<Float32Array> {
  const vocab = await loadMoveVocab();
  const logits = new Float32Array(vocab.length).fill(0);
  for (const uci of boostedUci) {
    const idx = vocab.indexOf(uci);
    if (idx === -1) {
      throw new Error(`Test setup error: "${uci}" not found in move vocab — check spelling/legality`);
    }
    logits[idx] = boostValue;
  }
  return logits;
}

function printRanking(label: string, moves: Awaited<ReturnType<typeof rerankMoves>>["moves"], topN = 5) {
  console.log(`\n--- ${label} (top ${topN}) ---`);
  for (const m of moves.slice(0, topN)) {
    console.log(
      `${m.san.padEnd(8)} uci=${m.uci.padEnd(5)} base=${m.baseProbability.toFixed(4)} ` +
        `adj=${m.adjustedProbability.toFixed(4)} boost=${m.boostFactor.toFixed(3)} ` +
        `cap=${m.isCapture ? "Y" : "n"} qcap=${m.isQueenCapture ? "Y" : "n"} chk=${m.isCheck ? "Y" : "n"}`
    );
  }
}

function assertClose(actual: number, expected: number, tolerance: number, label: string) {
  const diff = Math.abs(actual - expected);
  const pass = diff <= tolerance;
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}: actual=${actual.toFixed(6)} expected=${expected.toFixed(6)} diff=${diff.toExponential(2)}`);
  if (!pass) process.exitCode = 1;
}

async function main() {
  console.log("=== Test 1: Starting position, no boosted move, passive opponent ===");
  console.log("Sanity check: with flat logits and a passive opponent, renormalization");
  console.log("alone shouldn't blow up — all legal moves should land near 1/20 (20 legal first moves).");
  {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const logits = await fakeLogits([]); // all zero -> uniform softmax
    const opponent = fakeOpponent({ queenTradeRate: 0.1, aggressionIndex: 0.05 });
    const result = await rerankMoves({ fen, logitsMaia: logits, opponentFeatures: opponent });

    const legalMoveCount = result.moves.length;
    console.log(`Legal moves found: ${legalMoveCount} (expected 20 for starting position)`);
    if (legalMoveCount !== 20) process.exitCode = 1;

    const baseSum = result.moves.reduce((s, m) => s + m.baseProbability, 0);
    const adjSum = result.moves.reduce((s, m) => s + m.adjustedProbability, 0);
    assertClose(baseSum, 1, 1e-6, "baseProbability sums to 1 over legal moves");
    assertClose(adjSum, 1, 1e-6, "adjustedProbability sums to 1 over legal moves");

    printRanking("Flat logits, passive opponent", result.moves);
  }

  console.log("\n=== Test 2: Boost direction — aggressive opponent should favor captures/checks ===");
  console.log("Position: white to move, Nxe5 (capture) and a quiet developing move both plausible.");
  {
    // After 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6 (white captures) dxc6 5.Nxe5
    // Scholar's-mate-adjacent test position with a clean capture available:
    // using a simpler constructed FEN instead — white to move, can play
    // Nxe5 (capture) or Nf3 (quiet development).
    const fen = "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 3";
    // Legal captures from here: none actually (no piece attacks e5) —
    // switching to a position with an unambiguous capture on offer.
    const fenWithCapture = "rnbqkb1r/ppp2ppp/3p1n2/4N3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 4";
    // White knight on e5 can play Nxd7? no - let's use a textbook hanging pawn instead.
    // Simplify further: construct a position where Nxf7 (capture) is legal and clearly flagged.
    const fenFinal = "rnbqkb1r/ppppp1pp/5n2/5N2/8/8/PPPPPPPP/RNBQKB1R w KQkq - 2 3";
    // Ne5xf7 not legal from f5. Use a known tactic position instead, verified by hand:
    // Fried Liver-ish: white knight on e5 attacking f7.
    const fenKnownCapture =
      "r1bqkb1r/pppp1Npp/2n2n2/4p3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq - 0 1";
    // Here it's BLACK to move with white knight having just captured on f7
    // (a real capture already happened). Instead, give black a recapture:
    // Nxf7 is already played; black can play Kxf7 (a capture) or ignore it.
    const logitsCapture = await fakeLogits(["e1f2"]); // mirrored Kxf7 — recapture, "isCapture" true
    const logitsQuiet = await fakeLogits(["g1e2"]); // mirrored quiet-ish alternative, not a capture

    const aggressiveOpponent = fakeOpponent({ aggressionIndex: 0.9, queenTradeRate: 0.5 });
    const passiveOpponent = fakeOpponent({ aggressionIndex: 0.05, queenTradeRate: 0.5 });

    // Give BOTH candidate moves equal base logit, so any difference in
    // final ranking comes ONLY from the aggression boost, not from the
    // fake logits themselves.
    const equalLogits = await fakeLogits(["e1f2", "g1e2"], 5);

    const aggressiveResult = await rerankMoves({
      fen: fenKnownCapture,
      logitsMaia: equalLogits,
      opponentFeatures: aggressiveOpponent,
    });
    const passiveResult = await rerankMoves({
      fen: fenKnownCapture,
      logitsMaia: equalLogits,
      opponentFeatures: passiveOpponent,
    });

    printRanking("Equal base logits, AGGRESSIVE opponent (0.9)", aggressiveResult.moves, 3);
    printRanking("Equal base logits, PASSIVE opponent (0.05)", passiveResult.moves, 3);

    const aggCapture = aggressiveResult.moves.find((m) => m.uci === "e8f7")!;
    const passCapture = passiveResult.moves.find((m) => m.uci === "e8f7")!;
    console.log(
      `\nKxf7 adjustedProbability: aggressive=${aggCapture.adjustedProbability.toFixed(4)} ` +
        `passive=${passCapture.adjustedProbability.toFixed(4)}`
    );
    const pass = aggCapture.adjustedProbability > passCapture.adjustedProbability;
    console.log(`${pass ? "PASS" : "FAIL"} — aggressive opponent boosts the capture relative to passive opponent`);
    if (!pass) process.exitCode = 1;
  }

  console.log("\n=== Test 3: Illegal moves in logits are excluded entirely ===");
  {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    // "a1a8" is a rook teleporting through everything — not legal from the start position.
    const logits = await fakeLogits(["e2e4", "a1a8"], 10);
    const opponent = fakeOpponent({});
    const result = await rerankMoves({ fen, logitsMaia: logits, opponentFeatures: opponent });

    const hasIllegal = result.moves.some((m) => m.uci === "a1a8");
    console.log(`${!hasIllegal ? "PASS" : "FAIL"} — illegal move "a1a8" excluded from results`);
    if (hasIllegal) process.exitCode = 1;

    const e4 = result.moves.find((m) => m.uci === "e2e4");
    console.log(`PASS (informational) — e2e4 present, adjustedProbability=${e4?.adjustedProbability.toFixed(4)}`);
    printRanking("Illegal-move exclusion test", result.moves, 3);
  }

  console.log("\n=== Test 4: Checkmate position — zero legal moves, no crash ===");
  {
    // Fool's mate final position, black to move, checkmated.
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const logits = await fakeLogits([]);
    const opponent = fakeOpponent({});
    const result = await rerankMoves({ fen, logitsMaia: logits, opponentFeatures: opponent });

    const pass = result.moves.length === 0 && result.topMove === null && result.baseTopMove === null;
    console.log(`${pass ? "PASS" : "FAIL"} — checkmate position returns empty moves, null topMove, null baseTopMove`);
    if (!pass) process.exitCode = 1;
  }

  console.log("\n=== Test 5: Mismatched logits length throws, doesn't silently produce garbage ===");
  {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const badLogits = new Float32Array(100); // wrong length, real vocab is 1880
    const opponent = fakeOpponent({});
    try {
      await rerankMoves({ fen, logitsMaia: badLogits, opponentFeatures: opponent });
      console.log("FAIL — expected rerankMoves to throw on length mismatch, it did not");
      process.exitCode = 1;
    } catch (err) {
      console.log(`PASS — correctly threw on length mismatch: "${(err as Error).message}"`);
    }
  }

  console.log("\n=== Test 6: openingBoostApplied is always false (documented stub, not silently faked) ===");
  {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const logits = await fakeLogits([]);
    const opponent = fakeOpponent({
      mostCommonOpenings: [{ name: "Italian Game", eco: "C50", count: 10 }],
    });
    const result = await rerankMoves({ fen, logitsMaia: logits, opponentFeatures: opponent });
    const pass = result.openingBoostApplied === false;
    console.log(`${pass ? "PASS" : "FAIL"} — openingBoostApplied === false even with opening data present on OpponentFeatures`);
    if (!pass) process.exitCode = 1;
  }

  console.log("\n=== Test 7: Black-to-move logits map back from Maia's canonical orientation ===");
  {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
    // Maia sees this as the mirrored starting position and predicts e2e4;
    // on the real board that is e7e5.
    const logits = await fakeLogits(["e2e4"], 10);
    const result = await rerankMoves({
      fen,
      logitsMaia: logits,
      opponentFeatures: fakeOpponent({}),
    });
    const pass = result.baseTopMove?.uci === "e7e5";
    console.log(`${pass ? "PASS" : "FAIL"} — canonical e2e4 is mapped to legal Black move e7e5`);
    if (!pass) process.exitCode = 1;
  }

  console.log("\n=== Done ===");
  if (process.exitCode === 1) {
    console.log("ONE OR MORE TESTS FAILED — see above.");
  } else {
    console.log("All tests passed.");
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exitCode = 1;
});