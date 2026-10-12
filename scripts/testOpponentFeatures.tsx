/**
 * Run via: npx tsx scripts/testOpponentFeatures.ts <username>
 *
 * Same pattern as testFetchGames.ts / testExtractFeatures.ts / testFlagEngine.ts.
 * Calls extractOpponentFeatures directly (bypassing the API route and the
 * localStorage cache, both of which only exist client-side) against a live
 * Lichess account and prints the result.
 */
import { extractOpponentFeatures } from "../lib/lichess/opponentFeatures";

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: npx tsx scripts/testOpponentFeatures.ts <username>");
    process.exit(1);
  }

  console.log(`Fetching + analyzing last 20 rated rapid games for ${username}...`);
  const features = await extractOpponentFeatures(username, 20);

  console.log("\n--- OPPONENT FEATURES ---");
  console.log(`username: ${features.username}`);
  console.log(`gamesAnalyzed: ${features.gamesAnalyzed}`);
  console.log(`avgRating: ${features.avgRating}`);
  console.log(`queenTradeRate: ${(features.queenTradeRate * 100).toFixed(1)}%`);
  console.log(`aggressionIndex: ${(features.aggressionIndex * 100).toFixed(1)}%`);
  console.log("mostCommonOpenings:");
  for (const o of features.mostCommonOpenings) {
    console.log(`  ${o.name} (${o.eco}) — ${o.count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});