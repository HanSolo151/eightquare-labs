// Run with: npx tsx scripts/covCheck.ts <lichess_username> [maxGames] [depth]
//
// Standalone audit of the eval -> flagging data pipeline against REAL games,
// not synthetic fixtures like testFlagEngine.ts uses.
//
// Why this isn't just "call evalGame() from lib/eval/evalCache.ts":
// evalCache.ts's evalGame() calls evalFen() in lib/eval/stockfishEngine.ts,
// which spins up a browser `Worker` pointing at a static asset served from
// /api/stockfish/[asset]. That only exists inside a running Next.js page —
// it can't be invoked from a plain `tsx` script. evalCache.ts also persists
// to IndexedDB, which doesn't exist in Node either.
//
// So this script re-implements the same evaluation step using the `stockfish`
// npm package's Node entry point, loading the exact same lite-single engine
// build the app serves from /api/stockfish/[asset] (bin/stockfish-19-lite-single.js),
// at the same default search depth (14) the app currently uses in
// lib/eval/stockfishEngine.ts (SEARCH_DEPTH). Everything else — fetch, parse,
// FEN walk, mover-POV sign normalization — mirrors evalCache.ts's evalGame()
// exactly, so the coverage numbers this produces are the real numbers that
// pipeline would see, just computed outside the browser.
//
// This script does NOT read or write the app's IndexedDB eval cache, and it
// does NOT touch flagEngine.ts. It only answers one question: for real games,
// what fraction of plies come back with usable cpBefore/cpAfter data?

import { Chess } from "chess.js";
import stockfishFactory from "stockfish";
import { fetchGames } from "../lib/lichess/fetchGames";
import { parseGames } from "../lib/lichess/parseGame";

// --- CLI args ----------------------------------------------------------

const username = process.argv[2];
const maxGames = parseInt(process.argv[3] ?? "20", 10);
const depth = parseInt(process.argv[4] ?? "14", 10); // matches SEARCH_DEPTH in stockfishEngine.ts

if (!username) {
  console.error("Usage: npx tsx scripts/covCheck.ts <lichess_username> [maxGames=20] [depth=14]");
  process.exit(1);
}

// --- Node-side Stockfish wrapper (mirrors stockfishEngine.ts's parsing) ---

interface EvalResult {
  cp: number | null;
  mate: number | null;
  depth: number;
}

interface Engine {
  evalFen(fen: string): Promise<EvalResult>;
  terminate(): void;
}

function makeEngine(): Engine {
  let resolveReady: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });

  let currentResolve: ((r: EvalResult) => void) | null = null;
  let best: EvalResult = { cp: null, mate: null, depth: 0 };

  const sf = stockfishFactory("lite-single", (line: string) => {
    if (line === "uciok") {
      resolveReady();
      return;
    }
    if (line.startsWith("info") && line.includes("score")) {
      const cpMatch = line.match(/score cp (-?\d+)/);
      const mateMatch = line.match(/score mate (-?\d+)/);
      const depthMatch = line.match(/depth (\d+)/);
      if (depthMatch) best.depth = parseInt(depthMatch[1], 10);
      if (cpMatch) { best.cp = parseInt(cpMatch[1], 10); best.mate = null; }
      if (mateMatch) { best.mate = parseInt(mateMatch[1], 10); best.cp = null; }
    }
    if (line.startsWith("bestmove") && currentResolve) {
      const resolve = currentResolve;
      currentResolve = null;
      resolve(best);
    }
  });

  sf.processCommand("uci");

  // Single-flight queue — same "one search at a time per engine instance"
  // behavior as each slot in stockfishEngine.ts's ENGINE_POOL_SIZE pool.
  let queue: Promise<void> = ready;

  function evalFen(fen: string): Promise<EvalResult> {
    const result = queue.then(() => runOne(fen));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function runOne(fen: string): Promise<EvalResult> {
    best = { cp: null, mate: null, depth: 0 };
    return new Promise((resolve) => {
      currentResolve = resolve;
      sf.processCommand(`position fen ${fen}`);
      sf.processCommand(`go depth ${depth}`);
    });
  }

  return { evalFen, terminate: () => sf.terminate() };
}

// --- Coverage bookkeeping ------------------------------------------------

interface GameCoverage {
  gameId: string;
  expectedPlies: number;
  actualPlies: number;
  usablePlies: number;        // both cpBefore and cpAfter non-null -> centipawn-comparable
  mateOnlyPlies: number;      // at least one side is mate-only (cp null, mate set)
  missingPlies: number;       // both cp and mate null on either side
  shortDepthPlies: number;    // returned depth < requested depth
  invalidSan: string | null;  // set + aborts this game's walk if chess.js rejects a move
  usablePct: number;
}

function summarize(gameId: string, expectedPlies: number, points: {
  cpBefore: number | null; cpAfter: number | null;
  mateBefore: number | null; mateAfter: number | null;
  depth: number;
}[], invalidSan: string | null): GameCoverage {
  let usable = 0, mateOnly = 0, missing = 0, shortDepth = 0;

  for (const p of points) {
    const beforeResolved = p.cpBefore !== null || p.mateBefore !== null;
    const afterResolved = p.cpAfter !== null || p.mateAfter !== null;

    if (!beforeResolved || !afterResolved) {
      missing++;
    } else if (p.cpBefore !== null && p.cpAfter !== null) {
      usable++;
    } else {
      mateOnly++;
    }
    if (p.depth < depth) shortDepth++;
  }

  return {
    gameId,
    expectedPlies,
    actualPlies: points.length,
    usablePlies: usable,
    mateOnlyPlies: mateOnly,
    missingPlies: missing,
    shortDepthPlies: shortDepth,
    invalidSan,
    usablePct: points.length === 0 ? 0 : (usable / points.length) * 100,
  };
}

// --- Main ------------------------------------------------------------------

async function main() {
  console.log(`Fetching up to ${maxGames} rated games for ${username} (depth ${depth})...`);
  const raw = await fetchGames({ username, max: maxGames, rated: true });
  const games = parseGames(raw, username);
  console.log(`Parsed ${games.length}/${raw.length} games (rest failed to parse or weren't this user's).\n`);

  if (games.length === 0) {
    console.error("No games to audit. Nothing to report.");
    process.exit(1);
  }

  const engine = makeEngine();
  const results: GameCoverage[] = [];

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    process.stdout.write(`[${i + 1}/${games.length}] ${game.id} (${game.moves.length} plies)... `);

    const chess = new Chess();
    const points: { cpBefore: number | null; cpAfter: number | null; mateBefore: number | null; mateAfter: number | null; depth: number }[] = [];
    let invalidSan: string | null = null;

    try {
      let evalBefore = await engine.evalFen(chess.fen());

      for (let ply = 0; ply < game.moves.length; ply++) {
        const move = chess.move(game.moves[ply]);
        if (!move) {
          invalidSan = `"${game.moves[ply]}" at ply ${ply}`;
          break;
        }
        const evalAfter = await engine.evalFen(chess.fen());

        // Same mover-POV normalization as evalCache.ts: Stockfish reports
        // from side-to-move's POV, so "after" needs sign-flipping.
        points.push({
          cpBefore: evalBefore.cp,
          cpAfter: evalAfter.cp !== null ? -evalAfter.cp : null,
          mateBefore: evalBefore.mate,
          mateAfter: evalAfter.mate !== null ? -evalAfter.mate : null,
          depth: Math.min(evalBefore.depth, evalAfter.depth),
        });

        evalBefore = evalAfter;
      }
    } catch (err) {
      invalidSan = `engine error: ${(err as Error).message}`;
    }

    const coverage = summarize(game.id, game.moves.length, points, invalidSan);
    results.push(coverage);
    console.log(`${coverage.usablePct.toFixed(1)}% usable${invalidSan ? ` — ABORTED (${invalidSan})` : ""}`);
  }

  engine.terminate();

  // --- Aggregate report ---

  const totalExpected = results.reduce((s, r) => s + r.expectedPlies, 0);
  const totalActual = results.reduce((s, r) => s + r.actualPlies, 0);
  const totalUsable = results.reduce((s, r) => s + r.usablePlies, 0);
  const totalMateOnly = results.reduce((s, r) => s + r.mateOnlyPlies, 0);
  const totalMissing = results.reduce((s, r) => s + r.missingPlies, 0);
  const totalShortDepth = results.reduce((s, r) => s + r.shortDepthPlies, 0);
  const abortedGames = results.filter((r) => r.invalidSan !== null);
  const lowCoverageGames = results
    .filter((r) => r.invalidSan === null && r.usablePct < 90)
    .sort((a, b) => a.usablePct - b.usablePct);

  console.log("\n=== Flagging evaluation coverage ===");
  console.log(`Games:              ${results.length} audited, ${abortedGames.length} aborted mid-game`);
  console.log(`Plies expected:     ${totalExpected}`);
  console.log(`Plies walked:       ${totalActual}  (${totalExpected - totalActual} lost to aborts)`);
  console.log(`Usable (cp vs cp):  ${totalUsable}  (${totalActual === 0 ? 0 : ((totalUsable / totalActual) * 100).toFixed(1)}%)`);
  console.log(`Mate-only:          ${totalMateOnly}  (${totalActual === 0 ? 0 : ((totalMateOnly / totalActual) * 100).toFixed(1)}%)`);
  console.log(`Missing/malformed:  ${totalMissing}  (${totalActual === 0 ? 0 : ((totalMissing / totalActual) * 100).toFixed(1)}%)`);
  console.log(`Short-depth plies:  ${totalShortDepth}  (returned depth < ${depth})`);

  if (abortedGames.length > 0) {
    console.log(`\nAborted games (invalid SAN / engine error):`);
    for (const g of abortedGames) console.log(`  - ${g.gameId}: ${g.invalidSan}`);
  }

  if (lowCoverageGames.length > 0) {
    console.log(`\nGames under 90% usable (worth spot-checking):`);
    for (const g of lowCoverageGames) {
      console.log(`  - ${g.gameId}: ${g.usablePct.toFixed(1)}% usable, ${g.missingPlies} missing, ${g.mateOnlyPlies} mate-only`);
    }
  } else {
    console.log(`\nNo games under 90% usable.`);
  }
}

main().catch((err) => {
  console.error("covCheck failed:", err);
  process.exit(1);
});
