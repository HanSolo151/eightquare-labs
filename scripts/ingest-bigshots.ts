import { readFile } from "node:fs/promises";
import path from "node:path";
import { MATCHING_CONFIG } from "../config/matching";
import { prisma } from "../lib/prisma";
import { checkCausality } from "../lib/flags/causality";
import { MIN_CP_LOSS, resolveCpLoss } from "../lib/flags/flagEngine";
import { computeGameVectorDetails } from "../lib/matching/computeGameVector";
import { PHASES, type MatchPhase } from "../lib/matching/vectorSchema";
import type { GameEval, ParsedGame } from "../types";
import { evaluateServerGame } from "../lib/eval/evaluateServerGame";
import { StockfishCli } from "./lib/stockfishCli";
import { readPgnFromZip } from "./lib/pgnArchive";
import { buildCorpusPlan, parseTargetGames, persistCorpus, phaseAt, processTargetsIndependently, selectWinningCorpusGames, validateBigshotConfig, type AnalyzedGame, type BigshotConfig, type SourceGame } from "./lib/bigshotIngestion";

const EVAL_DEPTH = MATCHING_CONFIG.INGEST_EVAL_DEPTH;
const KNOWN_MIN_GAMES = MATCHING_CONFIG.BIGSHOT_MIN_GAMES;

async function fetchSource(target: BigshotConfig): Promise<SourceGame> {
  if (!target.sourceRef.trim()) throw new Error(`${target.name}: sourceRef is required`);
  let pgn: string;
  if (target.sourceType === "lichess_cc0") {
    if (!target.lichessUsername) throw new Error(`${target.name}: lichessUsername is required for lichess_cc0`);
    const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(target.lichessUsername)}`);
    url.searchParams.set("max", "3000");
    url.searchParams.set("clocks", "true");
    url.searchParams.set("opening", "true");
    const response = await fetch(url, { headers: { Accept: "application/x-chess-pgn" }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${target.name}: Lichess export failed with HTTP ${response.status}`);
    pgn = await response.text();
  } else if (target.sourceType === "lichess_broadcast_ccbysa") {
    if (!target.pgnUrl) throw new Error(`${target.name}: pgnUrl is required for a broadcast source`);
    if (!target.attribution?.trim()) throw new Error(`${target.name}: broadcast attribution is required`);
    const response = await fetch(target.pgnUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${target.name}: broadcast PGN fetch failed with HTTP ${response.status}`);
    pgn = await response.text();
  } else {
    if (target.pgnUrl) {
      const response = await fetch(target.pgnUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${target.name}: public-domain PGN fetch failed with HTTP ${response.status}`);
      pgn = await response.text();
    } else if (target.pgnPath) {
      pgn = await readFile(path.resolve(process.cwd(), target.pgnPath), "utf8");
    } else if (target.pgnZipPath) {
      pgn = await readPgnFromZip(path.resolve(process.cwd(), target.pgnZipPath));
    } else {
      throw new Error(`${target.name}: provide a pgnPath, pgnZipPath, or pgnUrl for historical_public_domain`);
    }
  }
  return {
    pgn,
    sourceRef: target.sourceRef,
    sourceType: target.sourceType,
    attribution: target.sourceType === "lichess_broadcast_ccbysa" ? target.attribution ?? null : null,
  };
}

async function evaluateGame(game: ParsedGame, engine: StockfishCli): Promise<GameEval> {
  return evaluateServerGame(game.id, game.moves, (fen) => engine.evaluate(fen, EVAL_DEPTH));
}

function objectiveFlags(game: ParsedGame, gameEval: GameEval): Array<{ ply: number; gamePhase: MatchPhase; color: "white" | "black" }> {
  const flagged: Array<{ ply: number; gamePhase: MatchPhase; color: "white" | "black" }> = [];
  for (const point of gameEval.points) {
    const color = point.ply % 2 === 0 ? "white" : "black";
    if (color !== game.playerColor) continue;
    const resolved = resolveCpLoss(point);
    if (!resolved || resolved.cpLoss < MIN_CP_LOSS) continue;
    if (!checkCausality(gameEval, point.ply, game.playerColor).heldToEnd) continue;
    flagged.push({ ply: point.ply, gamePhase: phaseAt(point.ply), color });
  }
  return flagged;
}

async function main(): Promise<void> {
  const configPath = path.join(process.cwd(), "config", "bigshots.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { bigshots?: BigshotConfig[] };
  const allTargets = config.bigshots ?? [];
  const targets = allTargets.filter((target) => target.enabled !== false);
  for (const target of allTargets.filter((entry) => entry.enabled === false)) {
    console.log(`${target.name}: skipped (disabled in config${target.note ? `: ${target.note}` : ""}).`);
  }
  if (targets.length === 0) {
    console.warn(`No bigshots configured in ${configPath}; add source metadata and source data before ingestion.`);
    return;
  }

  if (targets.some((target) => target.sourceType === "lichess_broadcast_ccbysa")) {
    console.warn("OPEN LEGAL ITEM: whether share-alike applies to derived vectors needs IP counsel review before commercial release.");
  }

  const engine = await StockfishCli.create();
  try {
    const prepared = await processTargetsIndependently(targets, async (target) => {
        validateBigshotConfig(target);
        const source = await fetchSource(target);
        const parsed = parseTargetGames(source, target, 0);
        const selection = selectWinningCorpusGames(parsed.map((entry) => entry.parsed));
        if (selection.skipped) {
          throw new Error(`${selection.availableWins} won games is below the configured ${MATCHING_CONFIG.BIGSHOT_INGEST_MIN_WINS}-win prefilter; no engine work performed`);
        }
        const selectedIds = new Set(selection.games.map((game) => game.id));
        const selectedParsed = parsed.filter((entry) => selectedIds.has(entry.parsed.id));
        console.info(`${target.name}: source=${parsed.length}, wins=${selection.availableWins}, selected=${selectedParsed.length}, policy=wins-only, cap=${MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS}.`);
        const games: AnalyzedGame[] = [];
        for (const { parsed: game, pgn } of selectedParsed) {
          const evaluation = await evaluateGame(game, engine);
          const flags = objectiveFlags(game, evaluation);
          const detail = computeGameVectorDetails(game, evaluation, flags);
          games.push({
            original: game,
            pgn,
            sourceRef: source.sourceRef,
            sourceType: source.sourceType,
            attribution: source.attribution,
            vectors: detail.vectors,
            details: detail.diagnostics,
          });
        }
        console.log(`${target.name}: evaluated ${games.length} games.`);
        return { config: target, games };
      }, (target, reason) => console.warn(`${target.name}: skipped (${reason}).`));

    const { eligible, rejected, stats } = buildCorpusPlan(prepared, KNOWN_MIN_GAMES);
    for (const item of rejected) {
      const short = PHASES.filter((phase) => item.games.filter((game) => game.vectors[phase] !== null).length < KNOWN_MIN_GAMES);
      if (short.length) console.warn(`${item.config.name}: phase profiles below floor for ${short.join(", ")}; not publishing this bigshot.`);
    }
    if (eligible.length === 0 || !stats) {
      console.warn("No bigshot has 250 eligible games in every phase. Nothing was written.");
      return;
    }
    await prisma.$transaction((tx) => persistCorpus(tx, eligible, stats));
    console.log(`Ingested ${eligible.length} bigshots with three calibrated phase profiles each.`);
  } finally {
    engine.close();
  }
}

main().catch((error) => {
  console.error("Bigshot ingestion failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
