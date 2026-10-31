import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { Chess } from "chess.js";
import { MATE_EQUIVALENT_CP } from "../lib/eval/toPlayerPerspective";

type RawFlag = {
  flagId: string; flagPly: number; moveNumber: number; san: string; color: string;
  flagType: string; severity: string; gamePhase: string; originalCpLoss: number;
  cascadeMeta: { startPly?: number; sequenceLength?: number; depthCp?: number } | null;
  moves: unknown; playerColor: string; points: unknown; engineVersion: string;
};
type Score = { cp: number | null; mate: number | null; depth: number; multipv: number; uci: string | null };
type SampleRow = {
  flagId: string; sample: number; stratum: string; phase: string; flagType: string; severity: string;
  originalEngineVersion: string;
  originalDepth: number | null; originalDepthGroup: "depth16" | "depth8-9" | "other" | "missing";
  originalCpLoss: number; higherDepthCpLoss: number; deltaCp: number;
  originalContainsMate: boolean; higherDepthContainsMate: boolean;
  result: "confirmed" | "downgraded" | "reversed"; forcedish: boolean | null;
  bestSecondGapCp: number | null; top3Lines: Array<{ uci: string | null; san: string | null; scoreCp: number | null; mate: number | null }>;
  fenBefore: string; san: string; uci: string;
  sequenceSan: string; depth: number; engine: string;
};

const SEARCH_DEPTH = 22;
const SEARCH_TIMEOUT_MS = 60 * 60_000;
const ROOT = process.cwd();
const ENGINE_PATH = path.join(ROOT, "node_modules", "stockfish", "bin", "stockfish-19-single.js");
const REPORT_DIR = path.join(ROOT, "artifacts", "evaluation");
const REPORT_JSON = path.join(REPORT_DIR, "flag-depth-stability.json");
const REPORT_MD = path.join(REPORT_DIR, "flag-depth-stability.md");
const REPORT_CSV = path.join(REPORT_DIR, "flag-depth-stability-full.csv");
const CHECKPOINT_JSON = path.join(REPORT_DIR, "flag-depth-stability-checkpoint.json");

function csv(value: unknown): string {
  const text = value === null || value === undefined ? "" :
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function scoreAsCp(score: Pick<Score, "cp" | "mate">): number | null {
  if (score.cp !== null && Number.isFinite(score.cp)) return score.cp;
  if (score.mate === null || !Number.isFinite(score.mate)) return null;
  const distance = Math.min(Math.abs(score.mate), 999);
  return score.mate > 0 ? MATE_EQUIVALENT_CP - distance : -MATE_EQUIVALENT_CP + distance;
}

function originalDepthGroup(depths: number[]): SampleRow["originalDepthGroup"] {
  if (!depths.length || depths.some((depth) => !Number.isFinite(depth))) return "missing";
  if (depths.every((depth) => depth === 16)) return "depth16";
  if (depths.every((depth) => depth === 8 || depth === 9)) return "depth8-9";
  return "other";
}

class UciStockfish {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReturnType<typeof createInterface>;
  private waiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private searchResult: { depth: number; multipv: number; score: Score; resolve: () => void; timer: NodeJS.Timeout } | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", this.onLine);
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => { if (code !== 0) this.failAll(new Error(`Stockfish exited (${code})`)); });
  }

  static async start(): Promise<UciStockfish> {
    const child = spawn(process.execPath, [ENGINE_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    const engine = new UciStockfish(child);
    try {
      const ready = engine.waitFor((line) => line === "uciok");
      engine.send("uci"); await ready;
      const isReady = engine.waitFor((line) => line === "readyok");
      engine.send("setoption name Threads value 1");
      engine.send("setoption name Hash value 256");
      engine.send("isready"); await isReady;
      return engine;
    } catch (error) { engine.close(); throw error; }
  }

  async evaluate(fen: string, multipv = 1): Promise<Score[]> {
    const requested = Math.max(1, multipv);
    const waitForBest = new Promise<Score[]>((resolve, reject) => {
      const latest = new Map<number, Score>();
      const timer = setTimeout(() => {
        this.searchResult = null;
        reject(new Error(`Stockfish depth-${SEARCH_DEPTH} search timed out`));
      }, SEARCH_TIMEOUT_MS);
      this.searchResult = {
        depth: SEARCH_DEPTH, multipv: requested,
        score: { cp: null, mate: null, depth: 0, multipv: 0, uci: null },
        resolve: () => {
          clearTimeout(timer);
          this.searchResult = null;
          resolve([...latest.values()].sort((a, b) => a.multipv - b.multipv));
        },
        timer,
      };
      (this.searchResult as typeof this.searchResult & { latest?: Map<number, Score> }).latest = latest;
    });
    this.send(`setoption name MultiPV value ${requested}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${SEARCH_DEPTH}`);
    return waitForBest;
  }

  close(): void { this.send("quit"); setTimeout(() => this.child.kill(), 500).unref(); }

  private send(command: string): void { this.child.stdin.write(`${command}\n`); }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => reject(new Error("UCI handshake timed out")), 60_000) };
      this.waiters.push(waiter);
    });
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters = [];
    if (this.searchResult) { clearTimeout(this.searchResult.timer); this.searchResult = null; }
  }

  private onLine = (line: string): void => {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(line)) { clearTimeout(waiter.timer); this.waiters = this.waiters.filter((item) => item !== waiter); waiter.resolve(line); }
    }
    const active = this.searchResult as (typeof this.searchResult & { latest?: Map<number, Score> }) | null;
    if (!active) return;
    if (line.startsWith("info")) {
      const depth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0);
      const multipv = Number(line.match(/\bmultipv (\d+)/)?.[1] ?? 1);
      if (depth < SEARCH_DEPTH || multipv > active.multipv) return;
      const cpMatch = line.match(/\bscore cp (-?\d+)/);
      const mateMatch = line.match(/\bscore mate (-?\d+)/);
      if (!cpMatch && !mateMatch) return;
      const uci = line.match(/\bpv (\S+)/)?.[1] ?? null;
      active.latest?.set(multipv, {
        cp: cpMatch ? Number(cpMatch[1]) : null,
        mate: mateMatch ? Number(mateMatch[1]) : null,
        depth, multipv, uci,
      });
      return;
    }
    if (line.startsWith("bestmove")) active.resolve();
  };
}

function fensForPly(moves: string[], ply: number): { before: string; after: string; san: string; uci: string } {
  const chess = new Chess();
  for (let i = 0; i < ply; i++) if (!chess.move(moves[i])) throw new Error(`Invalid SAN at ply ${i}`);
  const before = chess.fen();
  const move = chess.move(moves[ply]);
  if (!move) throw new Error(`Invalid SAN at sampled ply ${ply}`);
  return { before, after: chess.fen(), san: move.san, uci: move.from + move.to + (move.promotion ?? "") };
}

function classify(loss: number): SampleRow["result"] {
  if (loss >= 100) return "confirmed";
  if (loss > 0) return "downgraded";
  return "reversed";
}

async function allPersistedFlags(): Promise<RawFlag[]> {
  const censusSql = Prisma.sql`
    WITH classified AS (
      SELECT f."id" AS flag_id
      FROM "FlaggedMove" f
    )
    SELECT f."id" AS "flagId", f."ply" AS "flagPly", f."moveNumber", f."san", f."color",
      f."flagType", f."severity", f."gamePhase", f."cpLoss" AS "originalCpLoss",
      f."cascadeMeta" AS "cascadeMeta", g."moves" AS "moves", g."playerColor" AS "playerColor",
      e."points" AS "points", e."engineVersion" AS "engineVersion"
    FROM classified c
    JOIN "FlaggedMove" f ON f."id" = c.flag_id
    JOIN "Game" g ON g."id" = f."gameId"
    JOIN "GameEval" e ON e."gameId" = g."id"
    ORDER BY f."id"
  `;
  const rows = await prisma.$queryRaw<RawFlag[]>(censusSql);
  const total = await prisma.flaggedMove.count();
  if (rows.length !== total) {
    throw new Error(`Full diagnostic census requires every persisted flag to have a saved game evaluation (${rows.length}/${total} joined).`);
  }
  return rows;
}

async function persistedFlagDepthInventory(): Promise<Array<{ engineVersion: string; depth: number; flagCount: number }>> {
  return prisma.$queryRaw<Array<{ engineVersion: string; depth: number; flagCount: number }>>(Prisma.sql`
    SELECT e."engineVersion" AS "engineVersion",
      COALESCE((e."points" -> f."ply" ->> 'depth')::int, -1) AS "depth",
      COUNT(*)::int AS "flagCount"
    FROM "FlaggedMove" f
    JOIN "GameEval" e ON e."gameId" = f."gameId"
    GROUP BY e."engineVersion", COALESCE((e."points" -> f."ply" ->> 'depth')::int, -1)
    ORDER BY e."engineVersion", "depth"
  `);
}

async function main(): Promise<void> {
  const flags = await allPersistedFlags();
  if (!flags.length) throw new Error("No persisted flagged moves with saved evaluations were available for the census.");
  const depthInventory = await persistedFlagDepthInventory();
  const engine = await UciStockfish.start();
  const evalCache = new Map<string, Promise<Score[]>>();
  const evalAt = (fen: string, multipv = 1) => {
    const key = `${fen}|${multipv}|${SEARCH_DEPTH}`;
    const cached = evalCache.get(key);
    if (cached) return cached;
    const pending = engine.evaluate(fen, multipv);
    evalCache.set(key, pending);
    return pending;
  };
  const completedRows = new Map<string, SampleRow>();
  if (existsSync(CHECKPOINT_JSON)) {
    const saved: unknown = JSON.parse(await readFile(CHECKPOINT_JSON, "utf8"));
    if (!Array.isArray(saved) || saved.some((row) =>
      typeof row !== "object" || row === null || !("flagId" in row) ||
      typeof row.flagId !== "string" || !("depth" in row) || row.depth !== SEARCH_DEPTH
    )) {
      throw new Error(`Invalid depth-stability checkpoint at ${CHECKPOINT_JSON}`);
    }
    for (const row of saved as SampleRow[]) completedRows.set(row.flagId, row);
  }
  const rows: SampleRow[] = [];
  try {
    for (const [index, flag] of flags.entries()) {
      const cachedRow = completedRows.get(flag.flagId);
      if (cachedRow) {
        rows.push({ ...cachedRow, sample: index + 1 });
        console.log(`[${index + 1}/${flags.length}] cached ${cachedRow.result} ${cachedRow.stratum} ${cachedRow.phase}`);
        continue;
      }
      console.log(`[${index + 1}/${flags.length}] starting ${flag.flagId}`);
      const moves = Array.isArray(flag.moves) && flag.moves.every((move): move is string => typeof move === "string") ? flag.moves : null;
      const points = Array.isArray(flag.points) ? flag.points as Array<Record<string, unknown>> : null;
      if (!moves || !points || (flag.playerColor !== "white" && flag.playerColor !== "black")) {
        throw new Error(`Persisted flag ${flag.flagId} has invalid moves, evaluation points, or player color.`);
      }
      const meta = flag.cascadeMeta;
      const startPly = flag.flagType === "evaluation_cascade" || flag.flagType === "tilt_cascade"
        ? Number(meta?.startPly ?? flag.flagPly) : flag.flagPly;
      const sequenceLength = flag.flagType === "evaluation_cascade" || flag.flagType === "tilt_cascade"
        ? Math.max(1, Number(meta?.sequenceLength ?? 1)) : 1;
      const plies = Array.from({ length: sequenceLength }, (_, i) => startPly + 2 * i);
      if (plies.some((ply) => ply < 0 || ply >= moves.length)) {
        throw new Error(`Persisted flag ${flag.flagId} references an invalid move ply.`);
      }
      const positions = plies.map((ply) => fensForPly(moves, ply));
      const multi = await evalAt(positions[0].before, 3);
      const afterScores: Score[] = [];
      for (const position of positions) afterScores.push((await evalAt(position.after))[0]);
      if (!multi[0] || !afterScores.every(Boolean)) {
        throw new Error(`Stockfish returned incomplete depth-${SEARCH_DEPTH} scores for flag ${flag.flagId}.`);
      }
      let higherDepthCpLoss = 0;
      let higherDepthContainsMate = false;
      for (let i = 0; i < positions.length; i++) {
        const beforeScore = i === 0 ? multi[0] : (await evalAt(positions[i].before))[0];
        const beforeCp = beforeScore ? scoreAsCp(beforeScore) : null;
        const afterCp = scoreAsCp(afterScores[i]);
        if (beforeCp === null || afterCp === null) { higherDepthCpLoss = Number.NaN; break; }
        higherDepthContainsMate ||= beforeScore?.mate !== null || afterScores[i].mate !== null;
        // Scores are side-to-move POV; the post-move score is negated to put both on the mover's POV.
        higherDepthCpLoss += beforeCp - (-afterCp);
      }
      if (!Number.isFinite(higherDepthCpLoss)) {
        throw new Error(`Stockfish returned an unusable depth-${SEARCH_DEPTH} score for flag ${flag.flagId}.`);
      }
      const pointDepths = plies.map((ply) => Number(points[ply]?.depth)).filter(Number.isFinite);
      const originalContainsMate = plies.some((ply) => {
        const point = points[ply];
        return point?.mateBefore !== null || point?.mateAfter !== null;
      });
      const currentMove = positions[0];
      const gap = multi.length >= 2 ? (scoreAsCp(multi[0]) ?? NaN) - (scoreAsCp(multi[1]) ?? NaN) : NaN;
      const top3Lines = multi.map((line) => {
        let san: string | null = null;
        if (line.uci) {
          const board = new Chess(currentMove.before);
          try {
            const move = board.move({ from: line.uci.slice(0, 2), to: line.uci.slice(2, 4), promotion: line.uci.length > 4 ? line.uci.slice(4) : undefined });
            san = move?.san ?? null;
          } catch { san = null; }
        }
        return { uci: line.uci, san, scoreCp: scoreAsCp(line), mate: line.mate };
      });
      rows.push({
        flagId: flag.flagId, sample: index + 1,
        stratum: flag.flagType === "evaluation_cascade" || flag.flagType === "tilt_cascade" ? "cascade" : flag.severity,
        originalEngineVersion: flag.engineVersion,
        phase: flag.gamePhase, flagType: flag.flagType, severity: flag.severity,
        originalDepth: pointDepths.length ? Math.min(...pointDepths) : null,
        originalDepthGroup: originalDepthGroup(pointDepths),
        originalCpLoss: Number(flag.originalCpLoss), higherDepthCpLoss: Math.round(higherDepthCpLoss),
        deltaCp: Math.round(higherDepthCpLoss - Number(flag.originalCpLoss)),
        originalContainsMate, higherDepthContainsMate,
        result: classify(higherDepthCpLoss),
        forcedish: Number.isFinite(gap) ? gap < 30 : null,
        bestSecondGapCp: Number.isFinite(gap) ? Math.round(gap) : null,
        top3Lines,
        fenBefore: currentMove.before, san: currentMove.san, uci: currentMove.uci,
        sequenceSan: positions.map((position) => position.san).join(" "),
        depth: SEARCH_DEPTH, engine: "Stockfish 19 full single-threaded WASM",
      });
      completedRows.set(flag.flagId, rows.at(-1)!);
      await writeFile(CHECKPOINT_JSON, `${JSON.stringify([...completedRows.values()], null, 2)}\n`);
      console.log(`[${index + 1}/${flags.length}] ${rows.at(-1)?.result} ${rows.at(-1)?.stratum} ${rows.at(-1)?.phase}`);
    }
  } finally { engine.close(); }

  const groups = new Map<string, { total: number; confirmed: number; downgraded: number; reversed: number }>();
  const zeroGroup = () => ({ total: 0, confirmed: 0, downgraded: 0, reversed: 0 });
  groups.set("depth:depth16", zeroGroup());
  groups.set("depth:depth8-9", zeroGroup());
  groups.set("depth:other", zeroGroup());
  for (const row of rows) {
    const keys = ["overall", `depth:${row.originalDepthGroup}`, `exact-depth:${row.originalDepth ?? "missing"}`, `stratum:${row.stratum}`, `phase:${row.phase}`];
    for (const key of keys) {
      const counts = groups.get(key) ?? { total: 0, confirmed: 0, downgraded: 0, reversed: 0 };
      counts.total++; counts[row.result]++; groups.set(key, counts);
    }
  }
  const output = {
    generatedAt: new Date().toISOString(), source: "full census of persisted flags and saved game evaluations",
    census: true, requestedSearchDepth: SEARCH_DEPTH,
    engine: "Stockfish 19 full single-threaded WASM", population: flags.length, evaluated: rows.length,
    groups: Object.fromEntries(groups), rows, depthInventory,
    caveat: "Higher-depth Stockfish agreement is evaluation stability, not human-annotated mistake accuracy. `forcedish` means top-1 vs top-2 MultiPV score gap <30 cp.",
  };
  if (rows.length !== flags.length) {
    throw new Error(`Incomplete diagnostic census: evaluated ${rows.length}/${flags.length} persisted flags.`);
  }
  await mkdir(REPORT_DIR, { recursive: true });
  const cols: Array<keyof SampleRow> = ["flagId", "sample", "stratum", "phase", "flagType", "severity", "originalEngineVersion", "originalDepth", "originalDepthGroup", "originalCpLoss", "higherDepthCpLoss", "deltaCp", "originalContainsMate", "higherDepthContainsMate", "result", "forcedish", "bestSecondGapCp", "top3Lines", "fenBefore", "san", "uci", "sequenceSan", "depth", "engine"];
  await writeFile(REPORT_CSV, `${cols.join(",")}\n${rows.map((row) => cols.map((column) => csv(row[column])).join(",")).join("\n")}\n`);
  const percentage = (count: number, total: number) => total ? `${(100 * count / total).toFixed(1)}%` : "n/a";
  const table = ["| Group | n | Confirmed | Downgraded | Reversed |", "|---|---:|---:|---:|---:|"];
  for (const [key, count] of groups) table.push(`| ${key} | ${count.total} | ${count.confirmed} (${percentage(count.confirmed, count.total)}) | ${count.downgraded} (${percentage(count.downgraded, count.total)}) | ${count.reversed} (${percentage(count.reversed, count.total)}) |`);
  const forcedCount = rows.filter((row) => row.forcedish === true).length;
  const forcedN = rows.filter((row) => row.forcedish !== null).length;
  const sampledSeverityProjection = {
    low: rows.filter((row) => row.originalCpLoss >= 100 && row.originalCpLoss < 150).length,
    medium: rows.filter((row) => row.originalCpLoss >= 150 && row.originalCpLoss <= 200).length,
    high: rows.filter((row) => row.originalCpLoss > 200).length,
  };
  const thresholdGroups: Array<[string, SampleRow[]]> = [
    ["100-149cp", rows.filter((row) => row.originalCpLoss >= 100 && row.originalCpLoss < 150)],
    ["150-200cp", rows.filter((row) => row.originalCpLoss >= 150 && row.originalCpLoss <= 200)],
  ];
  const thresholdStability = Object.fromEntries(thresholdGroups.map(([key, selected]) => [key, {
    total: selected.length,
    confirmed: selected.filter((row) => row.result === "confirmed").length,
    downgraded: selected.filter((row) => row.result === "downgraded").length,
    reversed: selected.filter((row) => row.result === "reversed").length,
  }])) as Record<string, { total: number; confirmed: number; downgraded: number; reversed: number }>;
  const report = { ...output, sampledSeverityProjectionAt150Cp: sampledSeverityProjection, thresholdStabilityByOriginalCpLoss: thresholdStability };
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  const thresholdRows = Object.entries(thresholdStability).map(([key, value]) => {
    const group = value as { total: number; confirmed: number; downgraded: number; reversed: number };
    return `| ${key} | ${group.total} | ${group.confirmed} (${percentage(group.confirmed, group.total)}) | ${group.downgraded} (${percentage(group.downgraded, group.total)}) | ${group.reversed} (${percentage(group.reversed, group.total)}) |`;
  });
  await writeFile(REPORT_MD, ["# Flag depth-stability diagnostic", "", `Generated ${output.generatedAt}. Full census: ${rows.length}/${flags.length} persisted flags re-evaluated at depth ${SEARCH_DEPTH} using full Stockfish 19 single-threaded WASM.`, "", "This compares search stability, not human-label accuracy. Cascades are re-evaluated as the sum of their constituent own-move eval swings. A position is tagged multiple comparable options when the top-1 versus top-2 MultiPV score gap is below 30 cp. Mate transitions are included on the same synthetic 10,000 cp scale used in production and are marked per row.", "", ...table, "", `Multiple comparable options (<30 cp top-1/top-2 gap): ${forcedCount}/${forcedN} (${percentage(forcedCount, forcedN)}).`, "", `Projected severity labels from the full-census original cpLoss values under the 150cp medium floor (diagnostic only): ${JSON.stringify(sampledSeverityProjection)}.`, "", "### Stability around the low-tier boundary", "", "| Original cpLoss | n | Confirmed at depth 22 | Downgraded | Reversed |", "|---|---:|---:|---:|---:|", ...thresholdRows, "", "## Persisted depth inventory", "", "Actual evaluation depths at each persisted flag ply, grouped by stored engine version:", "", "| Engine version | Actual depth | Flags |", "|---|---:|---:|", ...depthInventory.map((item) => `| ${item.engineVersion} | ${item.depth < 0 ? "missing" : item.depth} | ${item.flagCount} |`), "", `Full census CSV: ${path.basename(REPORT_CSV)}`, ""].join("\n"));
  if (existsSync(CHECKPOINT_JSON)) await unlink(CHECKPOINT_JSON);
  console.log(`Wrote ${REPORT_MD} and ${REPORT_CSV} (${rows.length} evaluated rows).`);
}

main().catch((error: unknown) => {
  console.error("Flag depth-stability diagnostic failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); });
