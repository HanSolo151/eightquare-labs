// Run from this folder with: npx tsx test.ts
// This imports the real lib/sync/runSync.ts and swaps only its Prisma and
// Lichess fetcher dependencies for local in-memory fakes.

import { runSync } from "../../lib/sync/runSync";
import { __gameCount, __reset, __seedUser, __vanityJobCount } from "./fakes/prisma";
import {
  __resetSpy,
  __setNextBatch,
  fetchGamesCallCount,
  fetchGamesCallLog,
} from "./fakes/fetchGames";

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ""}`);
  }
}

async function scenarioThrottle() {
  console.log("\n[Scenario 1] passive reload within 60s should NOT call Lichess again");
  __reset();
  __resetSpy();
  __seedUser({ id: "u1", username: "maverick151", lastSyncedAt: null, lastGameCreatedAt: null });
  __setNextBatch([
    {
      id: "g1",
      moves: "e4 e5",
      players: {
        white: { user: { name: "maverick151" }, rating: 1500 },
        black: { user: { name: "opp" }, rating: 1490 },
      },
      rated: true,
      speed: "rapid",
      createdAt: 1000,
    },
  ]);

  const first = await runSync("u1");
  check("first call hits fetchGames (count=1)", fetchGamesCallCount === 1, `got ${fetchGamesCallCount}`);
  check("first call reports skipped=false", first.ok && first.skipped === false);
  check("first call synced 1 new game", first.ok && first.synced === 1, JSON.stringify(first));
  check("game actually persisted", __gameCount("u1") === 1);

  const second = await runSync("u1");
  check(
    "second (sub-60s) call does NOT hit fetchGames again",
    fetchGamesCallCount === 1,
    `expected call count to stay 1, got ${fetchGamesCallCount}`
  );
  check("second call reports skipped=true", second.ok && second.skipped === true, JSON.stringify(second));
  check("second call synced=0 (no Lichess call made)", second.ok && second.synced === 0);
  check("totalGames unchanged across the skip", second.ok && second.totalGames === 1);
}

async function scenarioForceAndWatermark() {
  console.log("\n[Scenario 2] force bypasses throttle; watermark prevents duplicate syncs");
  __reset();
  __resetSpy();
  __seedUser({ id: "u2", username: "maverick151", lastSyncedAt: null, lastGameCreatedAt: null });
  __setNextBatch([
    {
      id: "g1",
      moves: "e4 e5",
      players: {
        white: { user: { name: "maverick151" }, rating: 1500 },
        black: { user: { name: "opp" }, rating: 1490 },
      },
      rated: true,
      speed: "rapid",
      createdAt: 1000,
    },
    {
      id: "g2",
      moves: "d4 d5",
      players: {
        white: { user: { name: "maverick151" }, rating: 1500 },
        black: { user: { name: "opp2" }, rating: 1480 },
      },
      rated: true,
      speed: "rapid",
      createdAt: 2000,
    },
  ]);

  const firstClick = await runSync("u2", { force: true });
  check("first forced click: synced=2", firstClick.ok && firstClick.synced === 2, JSON.stringify(firstClick));
  check("totalGames=2 after first click", firstClick.ok && firstClick.totalGames === 2);

  const secondClick = await runSync("u2", { force: true });
  check(
    "second forced click still calls fetchGames",
    fetchGamesCallCount === 2,
    `got ${fetchGamesCallCount}`
  );
  check(
    "second forced click: synced=0 (no new games)",
    secondClick.ok && secondClick.synced === 0,
    JSON.stringify(secondClick)
  );
  check(
    "totalGames unchanged / no duplicates after second click",
    secondClick.ok && secondClick.totalGames === 2,
    JSON.stringify(secondClick)
  );
  check(
    "fetchGames used watermark from first click",
    fetchGamesCallLog[1]?.since === 2000,
    `got since=${fetchGamesCallLog[1]?.since}`
  );
}

async function scenarioThrottleRespectsForceFalseDefault() {
  console.log("\n[Scenario 3] default call (no opts) behaves as passive, not forced");
  __reset();
  __resetSpy();
  __seedUser({
    id: "u3",
    username: "x",
    lastSyncedAt: new Date(Date.now() - 1000),
    lastGameCreatedAt: null,
  });
  __setNextBatch([]);
  const result = await runSync("u3");
  check("recent lastSyncedAt causes a default skip", result.ok && result.skipped, JSON.stringify(result));
  check("no fetchGames call made", fetchGamesCallCount === 0);
}

async function scenarioConcurrentFirstSync() {
  console.log("\n[Scenario 4] concurrent first syncs racing on the same new game");
  __reset();
  __resetSpy();
  __seedUser({ id: "u4", username: "maverick151", lastSyncedAt: null, lastGameCreatedAt: null });
  __setNextBatch([
    {
      id: "race-game-1",
      moves: "e4 e5",
      players: {
        white: { user: { name: "maverick151" }, rating: 1500 },
        black: { user: { name: "opp" }, rating: 1490 },
      },
      rated: true,
      speed: "rapid",
      createdAt: 1000,
    },
  ]);

  const [a, b] = await Promise.all([runSync("u4"), runSync("u4")]);
  check(
    "neither concurrent call failed",
    a.ok && b.ok,
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`
  );
  check("exactly one game persisted", __gameCount("u4") === 1);
  check(
    "synced counts sum to one new row",
    a.ok && b.ok && a.synced + b.synced === 1,
    `a.synced=${a.ok ? a.synced : "n/a"} b.synced=${b.ok ? b.synced : "n/a"}`
  );
}

async function scenarioVanityEvaluationEnqueue() {
  console.log("\n[Scenario 5] sync enqueues only rated wins across speeds, idempotently");
  __reset();
  __resetSpy();
  __seedUser({ id: "u5", username: "maverick151", lastSyncedAt: null, lastGameCreatedAt: null });
  __setNextBatch([
    { id: "rated-rapid-win", moves: "e4 e5", players: { white: { user: { name: "maverick151" } }, black: { user: { name: "opp" } } }, rated: true, speed: "rapid", winner: "white", status: "mate", createdAt: 3000 },
    { id: "rated-blitz-win", moves: "d4 d5", players: { white: { user: { name: "opp" } }, black: { user: { name: "maverick151" } } }, rated: true, speed: "blitz", winner: "black", status: "mate", createdAt: 2000 },
    { id: "rated-loss", moves: "c4 e5", players: { white: { user: { name: "maverick151" } }, black: { user: { name: "opp" } } }, rated: true, speed: "bullet", winner: "black", status: "mate", createdAt: 1000 },
    { id: "unrated-win", moves: "Nf3 Nf6", players: { white: { user: { name: "maverick151" } }, black: { user: { name: "opp" } } }, rated: false, speed: "classical", winner: "white", status: "mate", createdAt: 500 },
  ]);
  const result = await runSync("u5", { force: true });
  check("all four games are synced", result.ok && result.synced === 4, JSON.stringify(result));
  check("two rated wins (rapid and blitz) are queued", __vanityJobCount("u5") === 2, `got ${__vanityJobCount("u5")}`);
  const again = await runSync("u5", { force: true });
  check("repeat sync does not duplicate queued jobs", again.ok && __vanityJobCount("u5") === 2);
}

(async () => {
  await scenarioThrottle();
  await scenarioForceAndWatermark();
  await scenarioThrottleRespectsForceFalseDefault();
  await scenarioConcurrentFirstSync();
  await scenarioVanityEvaluationEnqueue();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
