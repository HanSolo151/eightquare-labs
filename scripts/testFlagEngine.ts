// Run with: npx tsx scripts/testFlagEngine.ts <username>
// Runs Step 2 -> Step 3 -> Step 4 in sequence and prints flag engine output.

import { fetchGames } from "../lib/lichess/fetchGames";
import { parseGames } from "../lib/lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "../lib/features/extractFeatures";
import { flagMoves, checkProfileWarnings } from "../lib/flags/flagEngine";

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: npx tsx scripts/testFlagEngine.ts <username>");
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

  const profile = buildPlayerProfile(username, games, allFeatures);
  console.log("\nPlayer profile:");
  console.log(profile);

  // --- Step 4 additions ---
  const warnings = checkProfileWarnings(profile);
  console.log("\nWARNINGS:", warnings);

  const flagged = flagMoves(allFeatures, profile);
  console.log(`\nFLAGGED: ${flagged.length}`);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  flagged.forEach((f) => bySeverity[f.severity]++);
  console.log("By severity:", bySeverity);

  console.log("\nFirst 10 flagged moves:");
  console.log(flagged.slice(0, 10));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});