import * as ort from "onnxruntime-web";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import { boardToTensor, mirrorUci } from "@/lib/maia/boardToTensor";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { buildOpponentProfile, type OpponentProfile } from "@/lib/profile/opponentStyleProfile";
import { emptyOpeningTree, openingTreeMove, updateOpeningTree } from "@/lib/profile/openingTree";
import { styleAdjustedProbabilities } from "@/lib/maia/rerank";
import type { ParsedGame } from "@/types";

type Manifest = { players: Array<{ username?: string; name: string; rating: number }> };
type Phase = "Opening (<12)" | "Middlegame (12–40)" | "Endgame (>40)";
type Candidate = {
  uci: string; san: string; logit: number; probability: number;
  isCheck: boolean; isCapture: boolean; isQueenCapture: boolean; isQuiet: boolean;
};
type RetrievalEntry = { board: string; uci: string };
type Neighbor = { entry: RetrievalEntry; distance: number };
type Hyperparameters = {
  retrievalWeight: number; bucketWeight: number; k: number; distanceThreshold: number;
  tuningAccuracy: number; tuningPositions: number; tunedOpponents: string[]; frozenAt: string;
};
type PlayerResult = {
  id: number;
  username: string;
  counts: Record<Phase, { total: number; base: number; opening: number; bucket: number; retrieval: number }>;
  retrievalMatches: number;
  middlePositions: number;
};

const ROOT = process.cwd();
const MODEL_PATH = join(ROOT, "public", "models", "maia2_rapid_fp16.onnx");
const VOCAB_PATH = join(ROOT, "public", "data", "move_vocab.json");
const MANIFEST_PATH = join(ROOT, "public", "models", "maia4all_manifest.json");
const ARTIFACT_DIR = join(ROOT, "artifacts", "evaluation");
const CORPUS_PATH = join(ARTIFACT_DIR, "retrieval_60_corpus.json");
const FROZEN_PATH = join(ARTIFACT_DIR, "retrieval_hyperparameters_frozen.json");
const REPORT_PATH = join(ARTIFACT_DIR, "retrieval_60_report.json");
const PLAYER_COUNT = 60;
const TRAINING_GAMES = 64;
const TUNING_GAMES = 16;
const TEST_GAMES = 20;
const PHASES: Phase[] = ["Opening (<12)", "Middlegame (12–40)", "Endgame (>40)"];
const RETRIEVAL_WEIGHTS = [0, 0.25, 0.5, 0.75];
const BUCKET_WEIGHTS = [0, 0.1, 0.25, 0.5];
const KS = [1, 3, 5, 10];
const DISTANCE_THRESHOLDS = [0.03, 0.06, 0.1, 0.15];
const MAX_RETRIEVAL_K = Math.max(...KS);
const STYLE_STRENGTH = 0.5;

function phaseFor(ply: number): Phase {
  if (ply < 12) return PHASES[0];
  if (ply <= 40) return PHASES[1];
  return PHASES[2];
}

function blankCounts(): PlayerResult["counts"] {
  return Object.fromEntries(PHASES.map((phase) => [phase, { total: 0, base: 0, opening: 0, bucket: 0, retrieval: 0 }])) as PlayerResult["counts"];
}

function float32ToFloat16(values: Float32Array): Uint16Array {
  const output = new Uint16Array(values.length);
  const floatView = new Float32Array(1);
  const intView = new Int32Array(floatView.buffer);
  for (let i = 0; i < values.length; i++) {
    floatView[0] = values[i];
    const x = intView[0];
    let bits = (x >> 16) & 0x8000;
    let mantissa = (x >> 12) & 0x07ff;
    const exponent = (x >> 23) & 0xff;
    if (exponent < 103) output[i] = bits;
    else if (exponent > 142) output[i] = bits | 0x7c00 | (exponent === 255 && (x & 0x007fffff) ? 0x200 : 0);
    else if (exponent < 113) {
      mantissa |= 0x0800;
      output[i] = bits | ((mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1));
    } else {
      bits |= ((exponent - 112) << 10) | (mantissa >> 1);
      bits += mantissa & 1;
      output[i] = bits;
    }
  }
  return output;
}

async function infer(
  session: ort.InferenceSession, fen: string, selfRating: number | null, opponentRating: number | null,
): Promise<Float32Array> {
  const board = boardToTensor(fen);
  const result = await session.run({
    board: new ort.Tensor("float16", float32ToFloat16(board), [1, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(selfRating))]), [1]),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(opponentRating))]), [1]),
  });
  const data = result.logits_maia?.data;
  if (!data || !ArrayBuffer.isView(data)) throw new Error("Maia returned invalid logits.");
  return data instanceof Float32Array ? data : Float32Array.from(data as unknown as ArrayLike<number>);
}

function candidatesFor(chess: Chess, logits: Float32Array, vocabIndex: Map<string, number>): Candidate[] {
  const black = chess.turn() === "b";
  const candidates = chess.moves({ verbose: true }).flatMap((move) => {
    const uci = move.from + move.to + (move.promotion ?? "");
    const index = vocabIndex.get(black ? mirrorUci(uci) : uci);
    if (index === undefined || !Number.isFinite(logits[index])) return [];
    return [{
      uci, san: move.san, logit: logits[index], probability: 0,
      isCheck: move.san.includes("+") || move.san.includes("#"),
      isCapture: !!move.captured, isQueenCapture: move.captured === "q",
      isQuiet: !move.captured && !move.san.includes("+") && !move.san.includes("#"),
    }];
  });
  if (!candidates.length) return candidates;
  const max = Math.max(...candidates.map((move) => move.logit));
  const total = candidates.reduce((sum, move) => sum + Math.exp(move.logit - max), 0);
  for (const move of candidates) move.probability = Math.exp(move.logit - max) / total;
  return candidates;
}

function boardCode(fen: string): string {
  const output: string[] = [];
  for (const rank of fen.split(" ")[0].split("/")) {
    for (const symbol of rank) {
      if (symbol >= "1" && symbol <= "8") output.push(...Array(Number(symbol)).fill("."));
      else output.push(symbol);
    }
  }
  return output.join("");
}

function buildRetrievalIndex(games: ParsedGame[]): RetrievalEntry[] {
  const entries: RetrievalEntry[] = [];
  for (const game of games) {
    const chess = new Chess();
    for (let ply = 0; ply < game.moves.length; ply++) {
      const fen = chess.fen();
      const ownMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
      let move;
      try { move = chess.move(game.moves[ply]); } catch { break; }
      if (ownMove && ply >= 12 && ply <= 40) {
        entries.push({ board: boardCode(fen), uci: move.from + move.to + (move.promotion ?? "") });
      }
    }
  }
  return entries;
}

function nearestNeighbors(queryBoard: string, index: RetrievalEntry[], legal: Set<string>): Neighbor[] {
  const nearest: Neighbor[] = [];
  for (const entry of index) {
    let differences = 0;
    for (let i = 0; i < 64; i++) if (queryBoard[i] !== entry.board[i]) differences++;
    if (!legal.has(entry.uci)) continue;
    const neighbor = { entry, distance: differences / 64 };
    let insertAt = nearest.findIndex((item) => item.distance > neighbor.distance);
    if (insertAt < 0) insertAt = nearest.length;
    if (insertAt < MAX_RETRIEVAL_K) {
      nearest.splice(insertAt, 0, neighbor);
      if (nearest.length > MAX_RETRIEVAL_K) nearest.pop();
    }
  }
  return nearest;
}

function retrievalDistribution(neighbors: Neighbor[], k: number, threshold: number): Map<string, number> | null {
  const selected = neighbors.filter((neighbor) => neighbor.distance <= threshold).slice(0, k);
  if (!selected.length) return null;
  const distribution = new Map<string, number>();
  let total = 0;
  for (const neighbor of selected) {
    const weight = 1 / (0.02 + neighbor.distance);
    distribution.set(neighbor.entry.uci, (distribution.get(neighbor.entry.uci) ?? 0) + weight);
    total += weight;
  }
  for (const [uci, weight] of distribution) distribution.set(uci, weight / total);
  return distribution;
}

function blendChoice(
  candidates: Candidate[], style: Candidate[], retrieval: Map<string, number> | null,
  retrievalWeight: number, bucketWeight: number,
): string {
  const styleProb = new Map(style.map((move) => [move.uci, move.probability]));
  const useRetrievalWeight = retrieval ? retrievalWeight : 0;
  const activeBucketWeight = Math.min(bucketWeight, 1 - useRetrievalWeight);
  const baseWeight = 1 - useRetrievalWeight - activeBucketWeight;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = baseWeight * candidate.probability +
      activeBucketWeight * (styleProb.get(candidate.uci) ?? 0) +
      useRetrievalWeight * (retrieval?.get(candidate.uci) ?? 0);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best.uci;
}

function grid(): Hyperparameters[] {
  const configurations: Hyperparameters[] = [];
  for (const retrievalWeight of RETRIEVAL_WEIGHTS) {
    for (const bucketWeight of BUCKET_WEIGHTS) {
      if (retrievalWeight + bucketWeight > 1) continue;
      for (const k of KS) for (const distanceThreshold of DISTANCE_THRESHOLDS) {
        configurations.push({ retrievalWeight, bucketWeight, k, distanceThreshold, tuningAccuracy: 0, tuningPositions: 0, tunedOpponents: [], frozenAt: "" });
      }
    }
  }
  return configurations;
}

function newPlayerResult(id: number, username: string): PlayerResult {
  return { id, username, counts: blankCounts(), retrievalMatches: 0, middlePositions: 0 };
}

function updateTestRow(row: PlayerResult["counts"][Phase], actual: string, base: string, opening: string, bucket: string, retrieval: string): void {
  row.total++;
  if (actual === base) row.base++;
  if (actual === opening) row.opening++;
  if (actual === bucket) row.bucket++;
  if (actual === retrieval) row.retrieval++;
}

function pct(correct: number, total: number): string {
  return `${(100 * correct / Math.max(1, total)).toFixed(2)}%`;
}

function aggregateCounts(players: PlayerResult[]): PlayerResult["counts"] {
  const totals = blankCounts();
  for (const player of players) for (const phase of PHASES) {
    const a = totals[phase]; const b = player.counts[phase];
    a.total += b.total; a.base += b.base; a.opening += b.opening; a.bucket += b.bucket; a.retrieval += b.retrieval;
  }
  return totals;
}

async function loadOrFetchCorpus(manifest: Manifest): Promise<Array<{ id: number; username: string; rating: number; games: ParsedGame[] }>> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  let cached: Record<string, { id: number; rating: number; games: ParsedGame[] }> = {};
  try { cached = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as typeof cached; } catch { /* first run */ }
  const selected: Array<{ id: number; username: string; rating: number; games: ParsedGame[] }> = [];
  for (const [manifestId, person] of manifest.players.entries()) {
    if (selected.length >= PLAYER_COUNT) break;
    const username = person.username ?? person.name;
    let record = cached[username.toLowerCase()];
    if (!record || record.games.length < 100) {
      console.log(`[data ${selected.length + 1}/${PLAYER_COUNT}] ${username}: fetching 100 rated rapid games`);
      try {
        const rawGames = await fetchGames({ username, max: 100, rated: true, perfType: "rapid" });
        const parsed = parseGames(rawGames, username);
        if (parsed.length < 100) {
          console.warn(`  Skipping ${username}: only ${parsed.length} parseable games.`);
          continue;
        }
        // Lichess returns newest first. Prefer timestamps when all are present;
        // otherwise reverse the API order to preserve chronological discipline.
        const games = parsed.every((game) => game.createdAt !== null)
          ? parsed.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          : parsed.reverse();
        record = { id: manifestId, rating: person.rating, games };
        cached[username.toLowerCase()] = record;
        await writeFile(CORPUS_PATH, JSON.stringify(cached));
      } catch (error) {
        console.warn(`  Skipping ${username}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    selected.push({ id: record.id, username, rating: record.rating, games: record.games.slice(0, 100) });
  }
  if (selected.length < PLAYER_COUNT) throw new Error(`Only ${selected.length} opponents had 100 parseable games; need ${PLAYER_COUNT}.`);
  return selected;
}

function trainParts(games: ParsedGame[]) {
  if (games.length !== 100) throw new Error(`Expected exactly 100 games, got ${games.length}.`);
  return { train: games.slice(0, TRAINING_GAMES), tuning: games.slice(TRAINING_GAMES, TRAINING_GAMES + TUNING_GAMES), test: games.slice(-TEST_GAMES) };
}

async function tune(
  session: ort.InferenceSession,
  corpus: Awaited<ReturnType<typeof loadOrFetchCorpus>>,
  vocabIndex: Map<string, number>,
): Promise<Hyperparameters> {
  const candidates = grid();
  const totals = candidates.map(() => ({ correct: 0, positions: 0 }));
  for (const [playerIndex, player] of corpus.slice(0, 20).entries()) {
    console.log(`[tuning ${playerIndex + 1}/20] ${player.username}`);
    const { train, tuning } = trainParts(player.games);
    const profile = buildOpponentProfile(train);
    const index = buildRetrievalIndex(train);
    const tree = emptyOpeningTree(player.username);
    for (const game of train) updateOpeningTree(tree, game.id, game.moves, game.playerColor);
    for (const game of tuning) {
      const chess = new Chess();
      for (let ply = 0; ply < game.moves.length; ply++) {
        const fen = chess.fen();
        const ownMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
        let actual;
        try { actual = chess.move(game.moves[ply]); } catch { break; }
        if (!ownMove || ply < 12 || ply > 40) continue;
        const logits = await infer(session, fen, game.playerRating ?? player.rating, game.opponentRating);
        const legalCandidates = candidatesFor(new Chess(fen), logits, vocabIndex);
        if (!legalCandidates.length) continue;
        const base = legalCandidates.reduce((best, move) => move.logit > best.logit ? move : best);
        const style = styleAdjustedProbabilities(legalCandidates, profile, STYLE_STRENGTH);
        const nearest = nearestNeighbors(boardCode(fen), index, new Set(legalCandidates.map((move) => move.uci)));
        const distributions = new Map<string, Map<string, number> | null>();
        for (const k of KS) for (const threshold of DISTANCE_THRESHOLDS) {
          distributions.set(`${k}:${threshold}`, retrievalDistribution(nearest, k, threshold));
        }
        const actualUci = actual.from + actual.to + (actual.promotion ?? "");
        for (let i = 0; i < candidates.length; i++) {
          const config = candidates[i];
          const retrieval = distributions.get(`${config.k}:${config.distanceThreshold}`) ?? null;
          const prediction = blendChoice(legalCandidates, style, retrieval, config.retrievalWeight, config.bucketWeight);
          totals[i].positions++;
          if (prediction === actualUci) totals[i].correct++;
        }
      }
    }
  }
  let bestIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    const left = totals[i]; const right = totals[bestIndex];
    if (left.correct * right.positions > right.correct * left.positions) bestIndex = i;
    else if (left.correct * right.positions === right.correct * left.positions) {
      const c = candidates[i]; const b = candidates[bestIndex];
      if (c.retrievalWeight + c.bucketWeight < b.retrievalWeight + b.bucketWeight) bestIndex = i;
    }
  }
  const selected = candidates[bestIndex];
  const score = totals[bestIndex];
  return {
    ...selected,
    tuningAccuracy: score.correct / Math.max(1, score.positions),
    tuningPositions: score.positions,
    tunedOpponents: corpus.slice(0, 20).map((player) => player.username),
    frozenAt: new Date().toISOString(),
  };
}

async function runTest(
  session: ort.InferenceSession,
  player: Awaited<ReturnType<typeof loadOrFetchCorpus>>[number],
  vocabIndex: Map<string, number>,
  hyperparameters: Hyperparameters,
): Promise<PlayerResult> {
  console.log(`[test] ${player.username}`);
  const { train, test } = trainParts(player.games);
  const profile: OpponentProfile = buildOpponentProfile(train);
  const retrievalIndex = buildRetrievalIndex(train);
  const tree = emptyOpeningTree(player.username);
  for (const game of train) updateOpeningTree(tree, game.id, game.moves, game.playerColor);
  const result = newPlayerResult(player.id, player.username);

  for (const game of test) {
    const chess = new Chess();
    for (let ply = 0; ply < game.moves.length; ply++) {
      const fen = chess.fen();
      const ownMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
      let actual;
      try { actual = chess.move(game.moves[ply]); } catch { break; }
      if (!ownMove) continue;
      const logits = await infer(session, fen, game.playerRating ?? player.rating, game.opponentRating);
      const legalCandidates = candidatesFor(new Chess(fen), logits, vocabIndex);
      if (!legalCandidates.length) continue;
      const base = legalCandidates.reduce((best, move) => move.logit > best.logit ? move : best);
      const openingMove = ply < 12 ? openingTreeMove(tree, fen) : null;
      const treeMoveIsLegal = !!openingMove && legalCandidates.some((move) => move.uci === openingMove);
      const opening = treeMoveIsLegal ? openingMove! : base.uci;
      const phase = phaseFor(ply);
      const canUseStyle = phase === "Middlegame (12–40)";
      const style = canUseStyle
        ? styleAdjustedProbabilities(legalCandidates, profile, STYLE_STRENGTH)
        : legalCandidates;
      const bucket = treeMoveIsLegal ? opening : canUseStyle
        ? blendChoice(legalCandidates, style, null, 0, hyperparameters.bucketWeight)
        : base.uci;
      let retrievalChoice = treeMoveIsLegal ? opening : bucket;
      if (phase === "Middlegame (12–40)") {
        result.middlePositions++;
        const neighbors = nearestNeighbors(boardCode(fen), retrievalIndex, new Set(legalCandidates.map((move) => move.uci)));
        const distribution = retrievalDistribution(neighbors, hyperparameters.k, hyperparameters.distanceThreshold);
        if (distribution) {
          result.retrievalMatches++;
          retrievalChoice = blendChoice(legalCandidates, style, distribution, hyperparameters.retrievalWeight, hyperparameters.bucketWeight);
        }
      }
      const actualUci = actual.from + actual.to + (actual.promotion ?? "");
      updateTestRow(result.counts[phase], actualUci, base.uci, opening, bucket, retrievalChoice);
    }
  }
  return result;
}

function printAggregate(players: PlayerResult[]): void {
  const counts = aggregateCounts(players);
  console.log("\nUntouched final test: aggregate top-1 accuracy");
  console.log("Phase                 Positions  Base Maia  Opening tree  4-bucket  Retrieval");
  for (const phase of PHASES) {
    const row = counts[phase];
    console.log(`${phase.padEnd(21)} ${String(row.total).padStart(9)}  ${pct(row.base, row.total).padStart(9)}  ${pct(row.opening, row.total).padStart(12)}  ${pct(row.bucket, row.total).padStart(8)}  ${pct(row.retrieval, row.total).padStart(9)}`);
  }
  const overall = PHASES.reduce((a, phase) => ({
    total: a.total + counts[phase].total, base: a.base + counts[phase].base,
    opening: a.opening + counts[phase].opening, bucket: a.bucket + counts[phase].bucket,
    retrieval: a.retrieval + counts[phase].retrieval,
  }), { total: 0, base: 0, opening: 0, bucket: 0, retrieval: 0 });
  console.log(`${"Overall".padEnd(21)} ${String(overall.total).padStart(9)}  ${pct(overall.base, overall.total).padStart(9)}  ${pct(overall.opening, overall.total).padStart(12)}  ${pct(overall.bucket, overall.total).padStart(8)}  ${pct(overall.retrieval, overall.total).padStart(9)}`);
}

function printPerPlayer(players: PlayerResult[]): void {
  console.log("\nPer-player middlegame accuracy (retrieval vs Base Maia)");
  console.log("Opponent ID / username                   Positions  Base Maia  Retrieval  Delta");
  let regressions = 0;
  const deltas: number[] = [];
  for (const player of players) {
    const row = player.counts["Middlegame (12–40)"];
    const delta = (row.retrieval - row.base) / Math.max(1, row.total);
    deltas.push(delta);
    if (delta < 0) regressions++;
    console.log(`${`${player.id}: ${player.username}`.slice(0, 38).padEnd(39)} ${String(row.total).padStart(9)}  ${pct(row.base, row.total).padStart(9)}  ${pct(row.retrieval, row.total).padStart(9)}  ${(delta >= 0 ? "+" : "")}${(100 * delta).toFixed(2)} pp${delta < 0 ? "  REGRESSION" : ""}`);
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = (sorted[29] + sorted[30]) / 2;
  const matched = players.reduce((sum, player) => sum + player.retrievalMatches, 0);
  const middle = players.reduce((sum, player) => sum + player.middlePositions, 0);
  console.log(`\nMedian per-player middlegame delta: ${(100 * median).toFixed(2)} pp; players regressing: ${regressions}/${players.length}.`);
  console.log(`Retrieval matches: ${matched}/${middle} middlegame positions (${(100 * matched / Math.max(1, middle)).toFixed(2)}%); others fell back to 4-bucket.`);
}

async function main(): Promise<void> {
  const [manifest, vocab, modelBytes] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8").then((raw) => JSON.parse(raw) as Manifest),
    readFile(VOCAB_PATH, "utf8").then((raw) => JSON.parse(raw) as string[]),
    readFile(MODEL_PATH),
  ]);
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const corpus = await loadOrFetchCorpus(manifest);
  console.log(`\nReady: ${corpus.length} opponents × 100 games; chronological split ${TRAINING_GAMES}/${TUNING_GAMES}/${TEST_GAMES}.`);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"] });
  const vocabIndex = new Map(vocab.map((uci, index) => [uci, index]));

  let hyperparameters: Hyperparameters;
  try {
    hyperparameters = JSON.parse(await readFile(FROZEN_PATH, "utf8")) as Hyperparameters;
    console.log(`Using frozen retrieval settings: R=${hyperparameters.retrievalWeight}, B=${hyperparameters.bucketWeight}, k=${hyperparameters.k}, distance≤${hyperparameters.distanceThreshold}.`);
  } catch {
    console.log("No frozen settings found. Tuning on opponents 1–20 only; final test set remains untouched.");
    hyperparameters = await tune(session, corpus, vocabIndex);
    await writeFile(FROZEN_PATH, JSON.stringify(hyperparameters, null, 2));
    console.log(`Frozen settings: R=${hyperparameters.retrievalWeight}, B=${hyperparameters.bucketWeight}, k=${hyperparameters.k}, distance≤${hyperparameters.distanceThreshold}; tuning ${(100 * hyperparameters.tuningAccuracy).toFixed(2)}% on ${hyperparameters.tuningPositions} middlegame positions.`);
  }

  const results: PlayerResult[] = [];
  for (const [index, player] of corpus.entries()) {
    console.log(`[final test ${index + 1}/${PLAYER_COUNT}] ${player.username}`);
    results.push(await runTest(session, player, vocabIndex, hyperparameters));
  }
  printAggregate(results);
  printPerPlayer(results);
  const report = { hyperparameters, split: { training: TRAINING_GAMES, tuning: TUNING_GAMES, test: TEST_GAMES }, players: results };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  await session.release();
  console.log(`\nSaved frozen settings: ${FROZEN_PATH}`);
  console.log(`Saved full per-player report: ${REPORT_PATH}`);
}

main().catch((error: unknown) => {
  console.error("Retrieval generalization evaluation failed:", error);
  process.exitCode = 1;
});
