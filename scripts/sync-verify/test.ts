// Run from this folder with: npx tsx test.ts
// This imports the real lib/sync/runSync.ts and swaps only its Prisma and
// Lichess fetcher dependencies for local in-memory fakes.

import { runSync } from "../../lib/sync/runSync";
import { __gameCount, __gameCreatedAtRange, __reset, __seedGames, __seedUser, __vanityJobCount } from "./fakes/prisma";
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

function ratedWin(id: string, createdAt: number) {
  return {
    id,
    moves: "e4 e5",
    players: {
      white: { user: { name: "maverick151" }, rating: 1500 },
      black: { user: { name: `opponent-${id}` }, rating: 1490 },
    },
    rated: true,
    speed: "rapid",
    winner: "white",
    status: "mate",
    createdAt,
  };
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

async function scenarioSequentialHistoryBatches() {
  console.log("\n[Scenario 6] new-account history backfill persists sequential 100-game batches");
  __reset();
  __resetSpy();
  __seedUser({ id: "u6", username: "maverick151", lastSyncedAt: null, lastGameCreatedAt: null, historyBackfillComplete: false });
  __setNextBatch(Array.from({ length: 500 }, (_, index) => ratedWin(`history-${index + 1}`, 5000 - index)));

  let result = await runSync("u6", { force: true });
  check("first batch stores 100 and reports more history", result.ok && result.synced === 100 && !result.historyBackfillComplete, JSON.stringify(result));
  check("first request is capped at 100", fetchGamesCallLog[0]?.max === 100, JSON.stringify(fetchGamesCallLog[0]));
  check("batch is persisted before continuing", __gameCount("u6") === 100);

  // Simulate the page closing after batch one; the next page visit resumes
  // from the oldest stored timestamp and completes the remaining batches.
  for (let visitBatch = 0; visitBatch < 5 && result.ok && !result.historyBackfillComplete; visitBatch++) {
    result = await runSync("u6", { force: true, skipIncremental: true });
  }
  check("history completes at 500 stored games", result.ok && result.historyBackfillComplete && result.totalGames === 500, JSON.stringify(result));
  const historyCalls = fetchGamesCallLog.filter((call) => call.since === undefined);
  check("all five history batches were requested sequentially", historyCalls.length === 5, `got ${historyCalls.length}`);
  check("follow-up batches avoid redundant incremental requests", fetchGamesCallCount === 5, `got ${fetchGamesCallCount}`);
  check("stored history spans newest through oldest game", JSON.stringify(__gameCreatedAtRange("u6")) === JSON.stringify({ oldest: 4501, newest: 5000 }), JSON.stringify(__gameCreatedAtRange("u6")));
  check("history requests remain within 100 games", historyCalls.every((call) => call.max === 100), JSON.stringify(historyCalls.map((call) => call.max)));
}

async function scenarioExistingAccountBackfill() {
  console.log("\n[Scenario 7] existing account backfill walks older than its stored watermark");
  __reset();
  __resetSpy();
  __seedUser({
    id: "u7",
    username: "maverick151",
    lastSyncedAt: new Date(),
    lastGameCreatedAt: new Date(6000),
    historyBackfillComplete: false,
  });
  __seedGames(Array.from({ length: 25 }, (_, index) => ({
    userId: "u7",
    lichessGameId: `existing-${index}`,
    lichessCreatedAt: new Date(6000 - index),
    moves: ["e4", "e5"],
    rated: true,
    result: "win",
  })));
  __setNextBatch(Array.from({ length: 600 }, (_, index) => ratedWin(`older-${index + 1}`, 6000 - index)));

  const result = await runSync("u7", { force: true });
  const firstRequest = fetchGamesCallLog[0];
  const historyRequest = fetchGamesCallLog[1];
  check("existing account stores a bounded older batch", result.ok && result.synced === 100 && result.totalGames === 125, JSON.stringify(result));
  check("incremental request uses saved newest watermark", firstRequest?.since === 6000, JSON.stringify(firstRequest));
  check("backfill request starts before the oldest stored game", historyRequest?.until === 5975, JSON.stringify(historyRequest));
  check("backfill remains resumable", result.ok && !result.historyBackfillComplete);
  check("oldest stored timestamp moved backward", __gameCreatedAtRange("u7")?.oldest === 5876, JSON.stringify(__gameCreatedAtRange("u7")));
}

(async () => {
  await scenarioThrottle();
  await scenarioForceAndWatermark();
  await scenarioThrottleRespectsForceFalseDefault();
  await scenarioConcurrentFirstSync();
  await scenarioVanityEvaluationEnqueue();
  await scenarioSequentialHistoryBatches();
  await scenarioExistingAccountBackfill();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
