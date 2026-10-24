import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { StockfishCli } from "../lib/eval/stockfishCli";
import { evaluateServerGame } from "../lib/eval/evaluateServerGame";
import { computeGameVectorDetails } from "../lib/matching/computeGameVector";
import { prisma } from "../lib/prisma";
import { MATCHING_CONFIG } from "../config/matching";
import type { GameEval } from "../types";
import { buildCorpusPlan, parseTargetGames, persistCorpus, selectWinningCorpusGames, validateBigshotConfig, type AnalyzedGame, type BigshotConfig, type PreparedBigshot, type SourceGame } from "./lib/bigshotIngestion";
import { PHASES } from "../lib/matching/vectorSchema";

const ROOT = process.cwd();
const STAGING = path.join(ROOT, "artifacts", "bigshot-staging");
const DEPTH = MATCHING_CONFIG.INGEST_EVAL_DEPTH;
const ENGINE_VERSION = "stockfish-19-lite-single-depth" + DEPTH + "-corpus-v1";

interface StageRecord extends PreparedBigshot {
  schemaVersion: 1;
  evaluationDepth: number;
  engineVersion: string;
  sourceDigest: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fileName(name: string): string {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() + ".json";
}

async function getSource(target: BigshotConfig): Promise<SourceGame> {
  validateBigshotConfig(target);
  if (target.sourceType === "lichess_cc0") {
    if (!target.lichessUsername) throw new Error(target.name + ": lichessUsername is required");
    const url = new URL("https://lichess.org/api/games/user/" + encodeURIComponent(target.lichessUsername));
    url.searchParams.set("max", "3000");
    url.searchParams.set("clocks", "true");
    url.searchParams.set("opening", "true");
    const response = await fetch(url, { headers: { Accept: "application/x-chess-pgn" }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(target.name + ": Lichess export failed with HTTP " + response.status);
    return { pgn: await response.text(), sourceRef: target.sourceRef, sourceType: target.sourceType, attribution: null };
  }
  if (target.sourceType === "lichess_broadcast_ccbysa") {
    if (!target.pgnUrl || !target.attribution?.trim()) throw new Error(target.name + ": broadcast URL and attribution are required");
    const response = await fetch(target.pgnUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(target.name + ": broadcast PGN fetch failed with HTTP " + response.status);
    return { pgn: await response.text(), sourceRef: target.sourceRef, sourceType: target.sourceType, attribution: target.attribution };
  }
  if (target.pgnUrl) {
    const response = await fetch(target.pgnUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(target.name + ": PGN fetch failed with HTTP " + response.status);
    return { pgn: await response.text(), sourceRef: target.sourceRef, sourceType: target.sourceType, attribution: null };
  }
  if (target.pgnPath) {
    return {
      pgn: await readFile(path.resolve(ROOT, target.pgnPath), "utf8"),
      sourceRef: target.sourceRef,
      sourceType: target.sourceType,
      attribution: null,
    };
  }
  throw new Error(target.name + ": this staged runner requires a pgnPath or pgnUrl");
}

async function prepare(target: BigshotConfig, engine: StockfishCli): Promise<StageRecord> {
  const source = await getSource(target);
  const parsed = parseTargetGames(source, target, 0);
  const minimumWins = target.minWins ?? MATCHING_CONFIG.BIGSHOT_INGEST_MIN_WINS;
  const selection = selectWinningCorpusGames(parsed.map((item) => item.parsed), minimumWins);
  if (selection.skipped) throw new Error(selection.availableWins + " wins is below this target's " + minimumWins + "-win minimum");
  const selectedIds = new Set(selection.games.map((game) => game.id));
  const selected = parsed.filter((item) => selectedIds.has(item.parsed.id));
  console.log(target.name + ": source games=" + parsed.length + ", wins=" + selection.availableWins + ", selected=" + selected.length);
  const games: AnalyzedGame[] = [];
  for (const entry of selected) {
    const evaluation: GameEval = await evaluateServerGame(
      entry.parsed.id,
      entry.parsed.moves,
      (fen) => engine.evaluate(fen, DEPTH),
      undefined,
      undefined,
      ENGINE_VERSION,
    );
    const detail = computeGameVectorDetails(entry.parsed, evaluation);
    games.push({
      original: entry.parsed,
      pgn: entry.pgn,
      sourceRef: source.sourceRef,
      sourceType: source.sourceType,
      attribution: source.attribution,
      vectors: detail.vectors,
      details: detail.diagnostics,
    });
  }
  return {
    schemaVersion: 1,
    evaluationDepth: DEPTH,
    engineVersion: ENGINE_VERSION,
    sourceDigest: digest(source.pgn),
    config: target,
    games,
  };
}

async function stagePlayers(targets: BigshotConfig[], replaceExisting: boolean): Promise<void> {
  await mkdir(STAGING, { recursive: true });
  const engine = await StockfishCli.create();
  const failures: string[] = [];
  try {
    for (const target of targets) {
      const destination = path.join(STAGING, fileName(target.name));
      if (!replaceExisting) {
        try {
          await readFile(destination);
          console.log(target.name + ": already staged; keeping saved result");
          continue;
        } catch { /* Not staged yet. */ }
      }
      try {
        const record = await prepare(target, engine);
        const temp = destination + "." + process.pid + ".tmp";
        await writeFile(temp, JSON.stringify(record), "utf8");
        if (replaceExisting) {
          const { unlink } = await import("node:fs/promises");
          await unlink(destination).catch(() => undefined);
        }
        await rename(temp, destination);
        console.log(target.name + ": staged " + record.games.length + " depth-" + DEPTH + " games");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(target.name + ": " + message);
        console.error(target.name + ": staging failed: " + message);
      }
    }
  } finally {
    engine.close();
  }
  if (failures.length) throw new Error("Some targets were not staged:\n" + failures.join("\n"));
}

async function readAllStages(targets: BigshotConfig[]): Promise<PreparedBigshot[]> {
  const prepared: PreparedBigshot[] = [];
  for (const target of targets) {
    const stagePath = path.join(STAGING, fileName(target.name));
    const record = JSON.parse(await readFile(stagePath, "utf8")) as StageRecord;
    if (record.schemaVersion !== 1 || record.config.name !== target.name
      || record.evaluationDepth !== DEPTH || record.engineVersion !== ENGINE_VERSION) {
      throw new Error(target.name + ": stage is stale or uses a different depth/engine");
    }
    if (!target.pgnPath) throw new Error(target.name + ": stage verification requires a local PGN path");
    const currentPgn = await readFile(path.resolve(ROOT, target.pgnPath), "utf8");
    if (digest(currentPgn) !== record.sourceDigest) throw new Error(target.name + ": PGN changed; restage before publishing");
    if (record.config.sourceRef !== target.sourceRef || record.config.sourceType !== target.sourceType
      || record.config.minWins !== target.minWins || record.config.pgnPath !== target.pgnPath) {
      throw new Error(target.name + ": roster metadata changed; restage before publishing");
    }
    prepared.push({ config: target, games: record.games });
  }
  return prepared;
}

async function publish(targets: BigshotConfig[]): Promise<void> {
  const prepared = await readAllStages(targets);
  const plan = buildCorpusPlan(prepared, MATCHING_CONFIG.BIGSHOT_MIN_GAMES);
  const publishable = new Set(plan.eligible.map((item) => item.config.name));
  for (const item of prepared) {
    const counts = PHASES.map((phase) => phase + "=" + item.games.filter((game) => game.vectors[phase] !== null).length + "/" + MATCHING_CONFIG.BIGSHOT_MIN_GAMES);
    console.log(item.config.name + ": " + counts.join(", "));
  }
  const blocked = targets.map((target) => target.name).filter((name) => !publishable.has(name));
  if (blocked.length) throw new Error("No database writes performed; these players miss a phase floor: " + blocked.join(", "));
  if (!plan.stats || plan.eligible.length !== targets.length) throw new Error("Complete 30-player calibration could not be built; no database writes performed.");
  await prisma.$transaction((tx) => persistCorpus(tx, plan.eligible, plan.stats!), { maxWait: 10_000, timeout: 120_000 });
  console.log("Published " + plan.eligible.length + " players with one full-roster calibration.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const publishMode = args.includes("--publish-staged");
  const stageAllMode = args.includes("--stage-all");
  const replaceExisting = args.includes("--replace-staged");
  const nameArgs = args.filter((arg) => arg.startsWith("--stage-name="));
  const names = nameArgs.map((arg) => arg.slice("--stage-name=".length)).filter(Boolean);
  if (args.some((arg) => arg !== "--publish-staged" && arg !== "--stage-all" && arg !== "--replace-staged" && !arg.startsWith("--stage-name="))
    || (publishMode && (names.length > 0 || replaceExisting || stageAllMode)) || (stageAllMode && names.length > 0)
    || (!publishMode && !stageAllMode && names.length === 0)
    || (!publishMode && new Set(names).size !== names.length)) {
    throw new Error("Use --stage-all, --stage-name=EXACT ROSTER NAME (repeatable), optionally --replace-staged, or --publish-staged.");
  }
  const configPath = path.join(ROOT, "config", "bigshots.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { bigshots: BigshotConfig[] };
  const targets = config.bigshots.filter((target) => target.enabled !== false);
  if (targets.length !== 30) throw new Error("Configured active roster must contain exactly 30 players before staged publication.");
  if (publishMode) {
    await publish(targets);
    return;
  }
  const selected = stageAllMode ? targets : names.map((name) => {
    const target = targets.find((entry) => entry.name === name);
    if (!target) throw new Error("Unknown active roster name: " + name);
    return target;
  });
  console.log("Staging " + selected.length + " player(s) at depth-" + DEPTH + " only. Profiles and calibration will not be written until all 30 stages pass and --publish-staged is run.");
  await stagePlayers(selected, replaceExisting);
}

void main().catch((error) => {
  console.error("Staged bigshot ingestion failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
