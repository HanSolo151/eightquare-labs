import * as ort from "onnxruntime-web";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import { boardToTensor, mirrorUci } from "@/lib/maia/boardToTensor";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import type { ParsedGame } from "@/types";

type CachedOpponent = { id: number; rating: number; games: ParsedGame[] };
type Corpus = Record<string, CachedOpponent>;
type SliceName = "Overall" | "Forcing positions" | "Quiet positions" | "Played: check" | "Played: capture (not check)" | "Played: quiet";
type Coverage = { n: number; top1: number; top3: number; top5: number; top10: number; notTop10: number };
type PlayerCoverage = { id: number; username: string; coverage: Coverage };

const ROOT = process.cwd();
const MODEL_PATH = join(ROOT, "public", "models", "maia2_rapid_fp16.onnx");
const VOCAB_PATH = join(ROOT, "public", "data", "move_vocab.json");
const CORPUS_PATH = join(ROOT, "artifacts", "evaluation", "retrieval_60_corpus.json");
const REPORT_PATH = join(ROOT, "artifacts", "evaluation", "maia_candidate_coverage_60.json");
const MARKDOWN_PATH = join(ROOT, "artifacts", "evaluation", "maia_candidate_coverage_60.md");

function emptyCoverage(): Coverage { return { n: 0, top1: 0, top3: 0, top5: 0, top10: 0, notTop10: 0 }; }

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

async function infer(session: ort.InferenceSession, fen: string, playerRating: number | null, opponentRating: number | null): Promise<Float32Array> {
  const result = await session.run({
    board: new ort.Tensor("float16", float32ToFloat16(boardToTensor(fen)), [1, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(playerRating))]), [1]),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(opponentRating))]), [1]),
  });
  const data = result.logits_maia?.data;
  if (!data || !ArrayBuffer.isView(data)) throw new Error("Maia returned invalid logits.");
  return data instanceof Float32Array ? data : Float32Array.from(data as unknown as ArrayLike<number>);
}

function updateCoverage(coverage: Coverage, rank: number): void {
  coverage.n++;
  if (rank <= 1) coverage.top1++;
  if (rank <= 3) coverage.top3++;
  if (rank <= 5) coverage.top5++;
  if (rank <= 10) coverage.top10++;
  if (rank > 10) coverage.notTop10++;
}

function renderRow(label: string, coverage: Coverage): string {
  const rate = (correct: number) => `${(100 * correct / Math.max(1, coverage.n)).toFixed(2)}%`;
  return `| ${label} | ${coverage.n.toLocaleString("en-US")} | ${rate(coverage.top1)} | ${rate(coverage.top3)} | ${rate(coverage.top5)} | ${rate(coverage.top10)} | ${rate(coverage.notTop10)} |`;
}

function percent(correct: number, total: number): string {
  return `${(100 * correct / Math.max(1, total)).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const [corpus, vocab, modelBytes] = await Promise.all([
    readFile(CORPUS_PATH, "utf8").then((raw) => JSON.parse(raw) as Corpus),
    readFile(VOCAB_PATH, "utf8").then((raw) => JSON.parse(raw) as string[]),
    readFile(MODEL_PATH),
  ]);
  const opponents = Object.entries(corpus).slice(0, 60).map(([username, value]) => ({ username, ...value }));
  if (opponents.length !== 60 || opponents.some((opponent) => opponent.games.length !== 100)) {
    throw new Error("The cached evaluation corpus must contain 60 opponents with exactly 100 games each.");
  }
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"] });
  const vocabIndex = new Map(vocab.map((uci, index) => [uci, index]));
  const slices = new Map<SliceName, Coverage>([
    ["Overall", emptyCoverage()],
    ["Forcing positions", emptyCoverage()],
    ["Quiet positions", emptyCoverage()],
    ["Played: check", emptyCoverage()],
    ["Played: capture (not check)", emptyCoverage()],
    ["Played: quiet", emptyCoverage()],
  ]);
  const byOpponent: PlayerCoverage[] = [];
  let positionsProcessed = 0;
  let actualNotFoundInVocab = 0;

  for (const [playerIndex, player] of opponents.entries()) {
    console.log(`[${playerIndex + 1}/60] ${player.username}`);
    const playerCoverage = emptyCoverage();
    const validationGames = player.games.slice(-20); // Cached corpus is oldest-first.
    for (const game of validationGames) {
      const chess = new Chess();
      for (let ply = 0; ply < game.moves.length; ply++) {
        const fen = chess.fen();
        const targetTurn = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
        const verboseLegal = chess.moves({ verbose: true });
        let actual;
        try { actual = chess.move(game.moves[ply]); } catch { break; }
        if (!targetTurn || ply < 12 || ply > 40) continue;

        const logits = await infer(session, fen, game.playerRating ?? player.rating, game.opponentRating);
        const blackToMove = fen.split(" ")[1] === "b";
        const ranked = verboseLegal.flatMap((move) => {
          const uci = move.from + move.to + (move.promotion ?? "");
          const modelUci = blackToMove ? mirrorUci(uci) : uci;
          const index = vocabIndex.get(modelUci);
          return index === undefined || !Number.isFinite(logits[index]) ? [] : [{ uci, logit: logits[index], probability: 0, move }];
        });
        const maxLogit = Math.max(...ranked.map((candidate) => candidate.logit));
        const expTotal = ranked.reduce((sum, candidate) => sum + Math.exp(candidate.logit - maxLogit), 0);
        for (const candidate of ranked) candidate.probability = Math.exp(candidate.logit - maxLogit) / expTotal;
        ranked.sort((a, b) => b.probability - a.probability);
        const actualUci = actual.from + actual.to + (actual.promotion ?? "");
        const rankIndex = ranked.findIndex((candidate) => candidate.uci === actualUci);
        const rank = rankIndex < 0 ? Number.POSITIVE_INFINITY : rankIndex + 1;
        if (rankIndex < 0) actualNotFoundInVocab++;

        const isForcing = verboseLegal.some((move) => !!move.captured || move.san.includes("+") || move.san.includes("#"));
        const playedCheck = actual.san.includes("+") || actual.san.includes("#");
        const moveType: SliceName = playedCheck ? "Played: check" : actual.captured ? "Played: capture (not check)" : "Played: quiet";
        updateCoverage(slices.get("Overall")!, rank);
        updateCoverage(playerCoverage, rank);
        updateCoverage(slices.get(isForcing ? "Forcing positions" : "Quiet positions")!, rank);
        updateCoverage(slices.get(moveType)!, rank);
        positionsProcessed++;
      }
    }
    byOpponent.push({ id: player.id, username: player.username, coverage: playerCoverage });
    console.log(`  ${playerCoverage.n} middlegame positions`);
  }

  await session.release();
  const lines = [
    "# Maia Middlegame Candidate Coverage",
    "",
    "Base Maia ONNX only; legal moves ranked by Maia logits, with no reranker or opening-tree selection.",
    "Corpus: same cached 60 opponents, chronological 64/16/20 split; this diagnostic uses the newest 20-game test set per opponent.",
    `Positions evaluated: ${positionsProcessed}. Actual moves missing from the legal move vocabulary: ${actualNotFoundInVocab}.`,
    "",
    "| Slice | Positions | Top-1 | Top-3 | Top-5 | Top-10 | Not in top-10 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...["Overall", "Forcing positions", "Quiet positions", "Played: check", "Played: capture (not check)", "Played: quiet"].map((name) => renderRow(name, slices.get(name as SliceName)!)),
    "",
    "## By opponent",
    "",
    "| Maia4All ID | Opponent | Positions | Top-1 | Top-3 | Top-5 | Top-10 | Not in top-10 |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
    ...byOpponent.map((player) => `| ${player.id} | ${player.username} | ${player.coverage.n} | ${percent(player.coverage.top1, player.coverage.n)} | ${percent(player.coverage.top3, player.coverage.n)} | ${percent(player.coverage.top5, player.coverage.n)} | ${percent(player.coverage.top10, player.coverage.n)} | ${percent(player.coverage.notTop10, player.coverage.n)} |`),
  ];
  const report = {
    corpus: "retrieval_60_corpus.json",
    split: { training: 64, tuning: 16, test: 20 },
    positionsProcessed,
    actualNotFoundInVocab,
    overall: slices.get("Overall"),
    slices: Object.fromEntries(slices),
    byOpponent,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  await writeFile(MARKDOWN_PATH, lines.join("\n"));
  console.log(`\nSaved diagnostic: ${MARKDOWN_PATH}`);
  console.log(lines.slice(5, 14).join("\n"));
}

main().catch((error: unknown) => {
  console.error("Maia candidate coverage diagnostic failed:", error);
  process.exitCode = 1;
});
