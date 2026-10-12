import { fetchGames } from "../lib/lichess/fetchGames";
import { parseGames } from "../lib/lichess/parseGame";

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: npx tsx scripts/testFetchGames.ts <lichess_username>");
    process.exit(1);
  }

  console.log(`Fetching up to 5 rated rapid games for ${username}...`);
  const raw = await fetchGames({ username, max: 5, rated: true, perfType: "rapid" });
  console.log(`Raw games received: ${raw.length}`);

  if (raw.length === 0) {
    console.log("No games returned — check the username, or try rated: false / a different perfType.");
    return;
  }

  // Dump one raw game so we can eyeball the actual Lichess shape
  console.log("\n--- Sample raw game (first one) ---");
  console.log(JSON.stringify(raw[0], null, 2).slice(0, 1500), "...(truncated)");

  const parsed = parseGames(raw, username);
  console.log(`\nParsed games: ${parsed.length} (dropped: ${raw.length - parsed.length})`);

  console.log("\n--- Parsed summaries ---");
  for (const g of parsed) {
    console.log({
      id: g.id,
      color: g.playerColor,
      vs: g.opponentUsername,
      oppRating: g.opponentRating,
      result: g.result,
      moveCount: g.moves.length,
      hasClocks: !!g.clocks,
      clockSample: g.clocks?.slice(0, 4) ?? null,
      opening: g.openingName,
    });
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});