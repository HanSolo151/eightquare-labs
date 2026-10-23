import { prisma } from "../lib/prisma";

const WINDOW_DAYS = 28;
const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

async function main(): Promise<void> {
  const rows = await prisma.game.findMany({
    where: { lichessCreatedAt: { gte: since } },
    select: { userId: true, result: true, rated: true, speed: true, lichessCreatedAt: true, eval: { select: { gameId: true } } },
    orderBy: [{ userId: "asc" }, { lichessCreatedAt: "desc" }],
  });
  const byUser = new Map<string, typeof rows>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

  const countsBySpeedAndResult = new Map<string, number>();
  let eligibleRatedWinsAllSpeeds = 0;
  let ratedGames = 0;
  let baselineLatest25RapidGames = 0;
  let baselineUnevaluatedGames = 0;
  let baselineRatedRapidWins = 0;
  let baselineUnevaluatedWins = 0;
  let newEligibleUnevaluatedWins = 0;
  for (const games of byUser.values()) {
    const baselineGames = games.filter((game) => game.rated && game.speed === "rapid").slice(0, 25);
    baselineLatest25RapidGames += baselineGames.length;
    baselineUnevaluatedGames += baselineGames.filter((game) => !game.eval).length;
    baselineRatedRapidWins += baselineGames.filter((game) => game.result === "win").length;
    baselineUnevaluatedWins += baselineGames.filter((game) => game.result === "win" && !game.eval).length;
    for (const game of games) {
      if (!game.rated) continue;
      ratedGames++;
      const key = `${game.speed ?? "unknown"}:${game.result}`;
      countsBySpeedAndResult.set(key, (countsBySpeedAndResult.get(key) ?? 0) + 1);
      if (game.result === "win") {
        eligibleRatedWinsAllSpeeds++;
        if (!game.eval) newEligibleUnevaluatedWins++;
      }
    }
  }

  console.log(JSON.stringify({
    basis: "synced Game rows, by lichessCreatedAt; historical estimate, not a guaranteed forecast",
    windowDays: WINDOW_DAYS,
    since: since.toISOString(),
    syncedGames: rows.length,
    activeUsers: byUser.size,
    ratedGames,
    eligibleRatedWinsAllSpeeds,
    baselineLatest25RatedRapidGames: baselineLatest25RapidGames,
    baselineUnevaluatedRatedRapidGames: baselineUnevaluatedGames,
    baselineRatedRapidWinsWithinLatest25: baselineRatedRapidWins,
    baselineUnevaluatedRatedRapidWins: baselineUnevaluatedWins,
    newEligibleRatedWinsWithoutPersistedEvaluation: newEligibleUnevaluatedWins,
    roughAdditionalEvaluationsPerWeek: Number(((newEligibleUnevaluatedWins - baselineUnevaluatedWins) / (WINDOW_DAYS / 7)).toFixed(2)),
    speedAndResultCounts: Object.fromEntries(countsBySpeedAndResult),
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not estimate vanity-evaluation volume:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
