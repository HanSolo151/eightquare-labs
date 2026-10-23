import { readFile } from "node:fs/promises";
import path from "node:path";
import { MATCHING_CONFIG } from "../config/matching";
import { parseTargetGames, validateBigshotConfig, type BigshotConfig, type SourceGame } from "./lib/bigshotIngestion";

async function main(): Promise<void> {
  const configPath = path.join(process.cwd(), "config", "bigshots.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { bigshots?: unknown[] };
  const targets = config.bigshots ?? [];
  let totalParsed = 0;
  let totalPlies = 0;
  const rows: Array<{ name: string; file: string; pgnGames: number; parsedGames: number; totalPlies: number; rawFloor: string }> = [];

  for (const rawTarget of targets) {
    validateBigshotConfig(rawTarget);
    const target = rawTarget as BigshotConfig;
    const pgnPath = path.resolve(process.cwd(), target.pgnPath ?? "");
    const pgn = await readFile(pgnPath, "utf8");
    const source: SourceGame = { pgn, sourceRef: target.sourceRef, sourceType: target.sourceType, attribution: target.attribution ?? null };
    const parsed = parseTargetGames(source, target, 0);
    const plies = parsed.reduce((sum, game) => sum + game.parsed.moves.length, 0);
    totalParsed += parsed.length;
    totalPlies += plies;
    rows.push({
      name: target.name,
      file: path.relative(process.cwd(), pgnPath).replaceAll("\\", "/"),
      pgnGames: (pgn.match(/^\[Event\s/mg) ?? []).length,
      parsedGames: parsed.length,
      totalPlies: plies,
      rawFloor: parsed.length >= MATCHING_CONFIG.BIGSHOT_MIN_GAMES ? "passes" : "fails",
    });
  }

  console.log(JSON.stringify({
    mode: "read-only; parses local PGN only; no Stockfish, database, or writes",
    minimumGames: MATCHING_CONFIG.BIGSHOT_MIN_GAMES,
    entries: rows.length,
    totalParsedGames: totalParsed,
    totalMainlinePlies: totalPlies,
    approximateEngineSearchesIfFullIngestRuns: totalParsed + rows.length + totalPlies,
    targets: rows,
  }, null, 2));
}

main().catch((error) => {
  console.error("Bigshot preflight failed:", error);
  process.exitCode = 1;
});
