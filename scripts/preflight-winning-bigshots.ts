import { readFile } from "node:fs/promises";
import path from "node:path";
import { MATCHING_CONFIG } from "../config/matching";
import { selectWinningCorpusGames, type BigshotConfig } from "./lib/bigshotIngestion";

function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function surname(name: string): string {
  const comma = name.indexOf(",");
  return normalizeName(comma >= 0 ? name.slice(0, comma) : name.split(/\s+/).at(-1) ?? "");
}

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "bigshots.json"), "utf8")) as { bigshots: BigshotConfig[] };
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "data", "bigshots", "converted", "conversion-manifest.json"), "utf8")) as Array<{ output: string; gameHeaders: number }>;
  const targetRows = [];
  let selectedGames = 0;
  let selectedPliesEstimate = 0;

  for (const target of config.bigshots) {
    const filePath = path.resolve(process.cwd(), target.pgnPath!);
    const pgn = await readFile(filePath, "utf8");
    const chunks = pgn.split(/(?=^\[Event\s)/m).map((chunk) => chunk.trim()).filter(Boolean);
    const exactAliases = new Set([target.name, ...target.aliases].flatMap((name) => {
      const value = normalizeName(name);
      return [value, value.split(" ").sort().join(" ")];
    }));
    const surnameAliases = new Set([target.name, ...target.aliases].map(surname));
    const wins: Array<{ result: string; pliesEstimate: number }> = [];
    let matchedPlayerGames = 0;

    for (const chunk of chunks) {
      const blankLine = chunk.search(/\r?\n\s*\r?\n/);
      const headerText = blankLine < 0 ? chunk : chunk.slice(0, blankLine);
      const headers = new Map<string, string>();
      for (const [, key, value] of headerText.matchAll(/^\[(\w+)\s+"(.*)"\]\s*$/gm)) headers.set(key!, value!);
      const whiteName = headers.get("White") ?? "White";
      const blackName = headers.get("Black") ?? "Black";
      const white = normalizeName(whiteName);
      const black = normalizeName(blackName);
      const isWhite = exactAliases.has(white) || exactAliases.has(white.split(" ").sort().join(" ")) || surnameAliases.has(surname(whiteName));
      const isBlack = exactAliases.has(black) || exactAliases.has(black.split(" ").sort().join(" ")) || surnameAliases.has(surname(blackName));
      if (isWhite || isBlack) matchedPlayerGames++;
      const result = headers.get("Result");
      if (!((result === "1-0" && isWhite) || (result === "0-1" && isBlack))) continue;
      const moveText = blankLine < 0 ? "" : chunk.slice(blankLine);
      const fullMoveCount = [...moveText.matchAll(/\d+\.(?!\.)/g)].length;
      wins.push({ result: "win", pliesEstimate: Math.max(1, fullMoveCount * 2) });
    }

    const selection = selectWinningCorpusGames(wins);
    const sourceGames = manifest.find((entry) => entry.output === path.basename(filePath))?.gameHeaders ?? chunks.length;
    selectedGames += selection.games.length;
    const plies = selection.games.reduce((sum, game) => sum + game.pliesEstimate, 0);
    selectedPliesEstimate += plies;
    targetRows.push({
      name: target.name,
      sourceGames,
      matchedPlayerGames,
      wonGames: selection.availableWins,
      selectedForIngestion: selection.games.length,
      plies,
      preliminaryDecision: selection.skipped ? "skip: fewer than minimum wins" : "attempt capped win subset",
    });
  }

  const estimatedEnginePositions = selectedPliesEstimate + selectedGames;
  console.log(JSON.stringify({
    mode: "read-only PGN header/result scan; no Stockfish or database access",
    minimumSourceWinsToAttempt: MATCHING_CONFIG.BIGSHOT_INGEST_MIN_WINS,
    maximumSelectedWinsPerBigshot: MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS,
    bigshots: config.bigshots.length,
    selectedBigshots: targetRows.filter((row) => row.selectedForIngestion > 0).length,
    skippedNamesUnderMinimumWins: targetRows.filter((row) => row.selectedForIngestion === 0).map((row) => `${row.name} (${row.wonGames} wins)`),
    selectedGames,
    estimatedEnginePositions,
    roughSerialHoursAtMeasured1_81PositionsPerSecond: Number((estimatedEnginePositions / 1.81 / 3600).toFixed(1)),
    targets: targetRows,
  }, null, 2));
}

main().catch((error) => {
  console.error("Winning corpus preflight failed:", error);
  process.exitCode = 1;
});
