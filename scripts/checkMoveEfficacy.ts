// Efficacy check for piece-activity profiling (lib/profile/pieceActivityProfile.ts).
// Two layers, run separately:
//   1. CORRECTNESS — synthetic fixtures with known answers. If these fail,
//      the data is just wrong, full stop.
//   2. SIGNAL QUALITY — real data, no known answer, checking whether the
//      profile is stable/distinctive rather than noise. These are
//      statistical checks, not pass/fail assertions — read the numbers.
//
// Usage:
//   npx tsx scripts/testPieceActivityEfficacy.ts                  (correctness only)
//   npx tsx scripts/testPieceActivityEfficacy.ts --user <name>     (+ signal quality for one real user)
//   npx tsx scripts/testPieceActivityEfficacy.ts --compare <a> <b> (+ distinctiveness between two users)

import { parseStockfishInfoLine, type EvalResult } from "../lib/eval/stockfishEngine";
import { evaluateMoveSequence } from "../lib/eval/evalCache";
import { extractMoveFeatures } from "../lib/features/extractFeatures";
import {
  emptyPieceActivityProfile,
  updatePieceActivityProfile,
} from "../lib/profile/pieceActivityProfile";
import { fetchGames } from "../lib/lichess/fetchGames";
import { parseGames } from "../lib/lichess/parseGame";
import type { PieceActivityProfile, PieceType, GameEval, EvalPoint, ParsedGame } from "../types";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Layer 1: correctness, synthetic fixtures -------------------------------

function testBestMoveParsing() {
  console.log("\n[1] bestmove line parsing");

  let result: EvalResult = { cp: null, mate: null, depth: 0, bestMoveUci: null };
  result = parseStockfishInfoLine("info depth 16 score cp 34 pv e2e4 e7e5", result);
  check("cp parsed from info line", result.cp === 34, `got ${result.cp}`);
  check("depth parsed from info line", result.depth === 16, `got ${result.depth}`);
  check(
    "bestMoveUci untouched by info lines (only set from bestmove line)",
    result.bestMoveUci === null
  );

  // bestmove line itself isn't handled by parseStockfishInfoLine (that's
  // runEvaluation's job in the real code, handled before the function is
  // called) — so this just confirms the function doesn't choke on it or
  // silently corrupt prior state when fed one.
  const afterBestmove = parseStockfishInfoLine("bestmove e2e4 ponder e7e5", result);
  check(
    "parseStockfishInfoLine ignores non-info lines without throwing",
    afterBestmove.cp === 34
  );
}

function testPieceTypeFromSan() {
  console.log("\n[2] SAN → piece type classification");
  // Re-implemented locally since pieceTypeFromSan isn't exported — if you
  // export it from pieceActivityProfile.ts, swap this for a real import.
  function pieceTypeFromSan(san: string): PieceType {
    const c = san[0];
    if (c === "O") return "k";
    if (c === "N") return "n";
    if (c === "B") return "b";
    if (c === "R") return "r";
    if (c === "Q") return "q";
    if (c === "K") return "k";
    return "p";
  }

  const cases: [string, PieceType][] = [
    ["e4", "p"], ["exd5", "p"], ["e8=Q", "p"], ["e8=Q+", "p"],
    ["Nf3", "n"], ["Nxe5", "n"],
    ["Bb5", "b"], ["Bxf7+", "b"],
    ["Rae1", "r"], ["Rxf2", "r"],
    ["Qxf2", "q"], ["Qd5+", "q"],
    ["Kh1", "k"], ["Kxh2", "k"],
    ["O-O", "k"], ["O-O-O", "k"],
  ];
  for (const [san, expected] of cases) {
    check(`"${san}" → ${expected}`, pieceTypeFromSan(san) === expected, `got ${pieceTypeFromSan(san)}`);
  }
}

/** Builds a minimal synthetic GameEval where every ply's bestMoveUci is
 * controlled directly, rather than depending on a running Stockfish worker —
 * isolates updatePieceActivityProfile's aggregation logic from the engine. */
function buildSyntheticGameEval(moves: string[], bestMoveUcis: (string | null)[]): GameEval {
  const points = moves.map((_, ply) => ({
    ply,
    cpBefore: 0,
    cpAfter: 0,
    mateBefore: null,
    mateAfter: null,
    depth: 16,
    bestMoveUci: bestMoveUcis[ply] ?? null,
  }));
  return { gameId: "synthetic-1", points, evaluatedAt: Date.now(), engineVersion: "test" };
}

function testAggregationAgainstKnownSequence() {
  console.log("\n[3] updatePieceActivityProfile aggregation — Scholar's-mate-style sequence");

  // White's moves: 1.e4 (p) 2.Bc4 (b) 3.Qh5 (q) 4.Qxf7# (q, capture)
  // Full move list needs both colors interleaved for extractMoveFeatures to
  // work; black's replies are irrelevant filler, kept legal.
  const moves = ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"];
  const game: ParsedGame = {
    id: "synthetic-1",
    playerColor: "white",
    opponentUsername: "test",
    opponentRating: null,
    playerRating: null,
    moves,
    clocks: null,
    openingName: null,
    openingEco: null,
    result: "win",
    rated: false,
    speed: null,
    createdAt: null,
  };

  // Engine "agrees" with white's move at ply 0 (e2e4) and ply 4 (h5d5... no,
  // Qh5 is h4h5 is wrong too — Qh5 from d1 is d1h5), disagrees at ply 2
  // (says Nf3 instead of Bc4). ply 6 (Qxf7#) — engine agrees, f7 capture by
  // queen from h5: h5f7.
  const bestMoveUcis: (string | null)[] = [
    "e2e4", // ply 0: white e4 — MATCH (pawn)
    null,   // ply 1: black e5 — irrelevant, white-only profile
    "g1f3", // ply 2: white Bc4 (c1-c4 is wrong square for bishop start; real bishop move is f1c4) — engine says knight instead — MISMATCH
    null,   // ply 3: black Nc6
    "d1h5", // ply 4: white Qh5 — MATCH (queen)
    null,   // ply 5: black Nf6
    "h5f7", // ply 6: white Qxf7# — MATCH (queen)
  ];

  const gameEval = buildSyntheticGameEval(moves, bestMoveUcis);
  const moveFeatures = extractMoveFeatures(game);
  check("extractMoveFeatures produced 7 features", moveFeatures.length === 7, `got ${moveFeatures.length}`);

  const profile = emptyPieceActivityProfile("test");
  updatePieceActivityProfile(profile, game.id, moves, gameEval, moveFeatures, "white");

  const pawn = profile.byPieceType.p.opening;
  const bishop = profile.byPieceType.b.opening;
  const queen = profile.byPieceType.q.opening;

  check("pawn moveCount == 1 (e4)", pawn.moveCount === 1, `got ${pawn.moveCount}`);
  check("pawn engineTopMatchCount == 1", pawn.engineTopMatchCount === 1, `got ${pawn.engineTopMatchCount}`);

  check("bishop moveCount == 1 (Bc4)", bishop.moveCount === 1, `got ${bishop.moveCount}`);
  check(
    "bishop engineTopMatchCount == 0 (engine preferred a knight move)",
    bishop.engineTopMatchCount === 0,
    `got ${bishop.engineTopMatchCount}`
  );

  check("queen moveCount == 2 (Qh5, Qxf7#)", queen.moveCount === 2, `got ${queen.moveCount}`);
  check("queen tradeInitiatedCount == 1 (Qxf7# is a capture)", queen.tradeInitiatedCount === 1, `got ${queen.tradeInitiatedCount}`);
  check("queen engineTopMatchCount == 2", queen.engineTopMatchCount === 2, `got ${queen.engineTopMatchCount}`);

  check(
    "black's moves excluded entirely (playerColor filter)",
    profile.byPieceType.n.opening.moveCount === 0, // black's Nc6/Nf6 shouldn't count
    `got ${profile.byPieceType.n.opening.moveCount}`
  );

  check("evaluatedGameIds recorded", profile.evaluatedGameIds.includes("synthetic-1"));
  check("gamesEvaluated incremented", profile.gamesEvaluated === 1);

  // Idempotency: re-running on the same gameId should be a no-op (the
  // real pipeline skips already-evaluated games, but verifying it directly
  // guards against a future refactor removing that guard silently).
  updatePieceActivityProfile(profile, game.id, moves, gameEval, moveFeatures, "white");
  check(
    "re-running on the same gameId doesn't double-count",
    profile.byPieceType.q.opening.moveCount === 2,
    `got ${profile.byPieceType.q.opening.moveCount} (expected still 2, not 4)`
  );
}

// --- Layer 2: signal quality, real data --------------------------------------

type PieceRateVector = number[]; // one entry per (pieceType, phase) combo, move rate

const PIECE_TYPES: PieceType[] = ["p", "n", "b", "r", "q", "k"];
const PHASES = ["opening", "middlegame", "endgame"] as const;

function toRateVector(profile: PieceActivityProfile): PieceRateVector {
  const totalMoves = PIECE_TYPES.reduce(
    (sum, pt) => sum + PHASES.reduce((s, ph) => s + profile.byPieceType[pt][ph].moveCount, 0),
    0
  );
  if (totalMoves === 0) return PIECE_TYPES.flatMap(() => PHASES.map(() => 0));
  return PIECE_TYPES.flatMap((pt) => PHASES.map((ph) => profile.byPieceType[pt][ph].moveCount / totalMoves));
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

async function buildProfileForGames(username: string, games: ParsedGame[]): Promise<PieceActivityProfile> {
  const profile = emptyPieceActivityProfile(username);
  for (const game of games) {
    try {
      // This efficacy script runs in Node, where evalGame's IndexedDB cache
      // is unavailable. Evaluate directly; repeat runs trade cache speed for
      // a simpler one-off analysis path.
      const points: EvalPoint[] = await evaluateMoveSequence(game.moves);
      const gameEval: GameEval = {
        gameId: game.id,
        points,
        evaluatedAt: Date.now(),
        engineVersion: "test-no-cache",
      };
      const moveFeatures = extractMoveFeatures(game);
      updatePieceActivityProfile(profile, game.id, game.moves, gameEval, moveFeatures, game.playerColor);
    } catch (err) {
      console.error(`  (skipping ${game.id}: ${err instanceof Error ? err.message : err})`);
    }
  }
  return profile;
}

/**
 * Split-half reliability: if the profile is capturing a REAL, stable
 * tendency rather than noise, two profiles built from disjoint halves of
 * the same player's games should correlate strongly. A low correlation
 * means the signal is dominated by per-game randomness, not a real style —
 * i.e. the profile isn't "effective" yet, whatever the correctness checks say.
 */
async function testSplitHalfReliability(username: string) {
  console.log(`\n[4] Split-half reliability for ${username}`);
  const raw = await fetchGames({ username, max: 40, rated: true, perfType: "rapid" });
  const games = parseGames(raw, username);
  if (games.length < 10) {
    console.log(`  Not enough games (${games.length}) for a meaningful split — skipping.`);
    return;
  }

  const shuffled = [...games]; // not actually shuffling — splitting by fetch order (newest/oldest halves), flag if you want a true random split instead
  const half = Math.floor(shuffled.length / 2);
  const groupA = shuffled.slice(0, half);
  const groupB = shuffled.slice(half);

  console.log(`  Building profile A (${groupA.length} games)...`);
  const profileA = await buildProfileForGames(`${username}-A`, groupA);
  console.log(`  Building profile B (${groupB.length} games)...`);
  const profileB = await buildProfileForGames(`${username}-B`, groupB);

  const r = pearsonCorrelation(toRateVector(profileA), toRateVector(profileB));
  console.log(`  Pearson r (piece-type×phase move-rate vectors) = ${r.toFixed(3)}`);
  console.log(
    r > 0.7
      ? "  → Strong — looks like a real, stable per-player signal."
      : r > 0.4
      ? "  → Moderate — some signal, but noisy at this sample size. More games may help."
      : "  → Weak — at this sample size, this mostly looks like noise, not a stable style signal."
  );
}

/**
 * Distinctiveness: two DIFFERENT players' profiles should correlate less
 * strongly with each other than a player's own split-half does with itself
 * (test 4). If two unrelated players look just as similar as a player split
 * against themselves, the signal isn't actually differentiating styles.
 */
async function testDistinctiveness(userA: string, userB: string) {
  console.log(`\n[5] Distinctiveness: ${userA} vs ${userB}`);
  const [rawA, rawB] = await Promise.all([
    fetchGames({ username: userA, max: 30, rated: true, perfType: "rapid" }),
    fetchGames({ username: userB, max: 30, rated: true, perfType: "rapid" }),
  ]);
  const gamesA = parseGames(rawA, userA);
  const gamesB = parseGames(rawB, userB);

  console.log(`  Building profile for ${userA} (${gamesA.length} games)...`);
  const profileA = await buildProfileForGames(userA, gamesA);
  console.log(`  Building profile for ${userB} (${gamesB.length} games)...`);
  const profileB = await buildProfileForGames(userB, gamesB);

  const r = pearsonCorrelation(toRateVector(profileA), toRateVector(profileB));
  console.log(`  Pearson r (cross-player) = ${r.toFixed(3)}`);
  console.log(
    "  Compare this against test [4]'s split-half r for either player — if cross-player r is close to or higher than split-half r, the profile isn't distinguishing real style differences from noise."
  );
}

// --- Entry point --------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  console.log("=== Piece-activity profiling: correctness ===");
  testBestMoveParsing();
  testPieceTypeFromSan();
  testAggregationAgainstKnownSequence();
  console.log(`\nCorrectness: ${pass} passed, ${fail} failed`);

  const userIdx = args.indexOf("--user");
  if (userIdx !== -1 && args[userIdx + 1]) {
    console.log("\n=== Piece-activity profiling: signal quality (real data) ===");
    await testSplitHalfReliability(args[userIdx + 1]);
  }

  const compareIdx = args.indexOf("--compare");
  if (compareIdx !== -1 && args[compareIdx + 1] && args[compareIdx + 2]) {
    await testDistinctiveness(args[compareIdx + 1], args[compareIdx + 2]);
  }

  if (fail > 0) {
    console.error(`\n${fail} correctness check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
