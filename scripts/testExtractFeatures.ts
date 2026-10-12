// Run with: npx tsx scripts/testExtractFeatures.ts <username>
// Fetches live games (reuses Step 2's fetchGames/parseGame), extracts
// move features, builds a profile, and prints a summary for spot-checking
// against the raw data — same pattern as testFetchGames.ts from Step 2.

import { fetchGames } from "../lib/lichess/fetchGames";
import { parseGames } from "../lib/lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "../lib/features/extractFeatures";

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: npx tsx scripts/testExtractFeatures.ts <username>");
    process.exit(1);
  }

  const raw = await fetchGames({ username, max: 5, rated: true, perfType: "rapid" });
  const games = parseGames(raw, username);
  console.log(`Parsed ${games.length} games.`);

  const allFeatures = extractAllMoveFeatures(games);
  console.log(`Extracted ${allFeatures.length} total move features.`);

  const premoves = allFeatures.filter((f) => f.likelyPremove).length;
  console.log(`likelyPremove flagged: ${premoves} (${((premoves / allFeatures.length) * 100).toFixed(1)}%)`);

  const forcing = allFeatures.filter((f) => f.isForcing).length;
  console.log(`isForcing flagged: ${forcing} (${((forcing / allFeatures.length) * 100).toFixed(1)}%)`);

  // Spot-check: print first 10 features of the first game
  const firstGameId = games[0]?.id;
  console.log(`\nFirst 10 move features for game ${firstGameId}:`);
  console.log(
    allFeatures
      .filter((f) => f.gameId === firstGameId)
      .slice(0, 10)
      .map((f) => ({
        ply: f.ply,
        moveNumber: f.moveNumber,
        color: f.color,
        san: f.san,
        timeSpentSec: f.timeSpentSec,
        likelyPremove: f.likelyPremove,
        isForcing: f.isForcing,
        phase: f.gamePhase,
      }))
  );

  const profile = buildPlayerProfile(username, games, allFeatures);
  console.log("\nPlayer profile:");
  console.log(profile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});