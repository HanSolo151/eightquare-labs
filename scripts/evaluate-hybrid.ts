import * as ort from "onnxruntime-web";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import { boardToTensor, mirrorUci } from "@/lib/maia/boardToTensor";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import { emptyOpeningTree, openingTreeMove, updateOpeningTree } from "@/lib/profile/openingTree";

type Game = {
  id: string; playerColor: "white" | "black"; playerRating: number | null;
  opponentRating: number | null; moves: string[]; createdAt: number;
};
type Player = { id: number; rating: number; games: Game[] };
type Phase = "Opening (<12)" | "Middlegame (12-40)" | "Endgame (>40)";
type Counts = { total: number; baseCorrect: number; shippedCorrect: number; treeMatches: number };
type PlayerResult = { username: string; phases: Record<Phase, Counts> };

const ROOT = process.cwd();
const MODEL = join(ROOT, "public/models/maia2_rapid_fp16.onnx");
const VOCAB = join(ROOT, "public/data/move_vocab.json");
const CORPUS = join(ROOT, "artifacts/evaluation/retrieval_60_corpus.json");
const OUT_JSON = join(ROOT, "artifacts/evaluation/shipped_baseline_60.json");
const OUT_MD = join(ROOT, "artifacts/evaluation/shipped_baseline_60.md");
const TRAIN_GAMES = 64;
const TEST_GAMES = 20;
const PHASES: Phase[] = ["Opening (<12)", "Middlegame (12-40)", "Endgame (>40)"];

function toFloat16(values: Float32Array): Uint16Array {
  const result = new Uint16Array(values.length), f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
  for (let i = 0; i < values.length; i++) {
    f32[0] = values[i]; const x = i32[0]; let bits = (x >> 16) & 0x8000;
    let mantissa = (x >> 12) & 0x07ff; const exponent = (x >> 23) & 0xff;
    if (exponent < 103) result[i] = bits;
    else if (exponent > 142) result[i] = bits | 0x7c00 | (exponent === 255 && (x & 0x007fffff) ? 0x200 : 0);
    else if (exponent < 113) { mantissa |= 0x0800; result[i] = bits | ((mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1)); }
    else { bits |= ((exponent - 112) << 10) | (mantissa >> 1); bits += mantissa & 1; result[i] = bits; }
  }
  return result;
}

async function infer(session: ort.InferenceSession, fen: string, self: number | null, opponent: number | null): Promise<Float32Array> {
  const result = await session.run({
    board: new ort.Tensor("float16", toFloat16(boardToTensor(fen)), [1, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(self))]), [1]),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(opponent))]), [1]),
  });
  const data = result.logits_maia?.data;
  if (!data || !ArrayBuffer.isView(data)) throw new Error("Maia returned invalid logits_maia output.");
  return data instanceof Float32Array ? data : Float32Array.from(data as unknown as ArrayLike<number>);
}

function topLegalMove(fen: string, logits: Float32Array, index: Map<string, number>): string | null {
  const chess = new Chess(fen), mirror = chess.turn() === "b";
  let best: string | null = null, bestLogit = -Infinity;
  for (const move of chess.moves({ verbose: true })) {
    const uci = move.from + move.to + (move.promotion ?? "");
    const modelUci = mirror ? mirrorUci(uci) : uci;
    const i = index.get(modelUci);
    if (i !== undefined && Number.isFinite(logits[i]) && logits[i] > bestLogit) { best = uci; bestLogit = logits[i]; }
  }
  return best;
}

function blank(): Record<Phase, Counts> {
  return Object.fromEntries(PHASES.map((p) => [p, { total: 0, baseCorrect: 0, shippedCorrect: 0, treeMatches: 0 }])) as Record<Phase, Counts>;
}
function phase(ply: number): Phase { return ply < 12 ? PHASES[0] : ply <= 40 ? PHASES[1] : PHASES[2]; }
function pct(correct: number, total: number): string { return total ? `${(100 * correct / total).toFixed(2)}%` : "n/a"; }

async function main() {
  const [corpus, vocab, modelBytes] = await Promise.all([
    readFile(CORPUS, "utf8").then((raw) => JSON.parse(raw) as Record<string, Player>),
    readFile(VOCAB, "utf8").then((raw) => JSON.parse(raw) as string[]),
    readFile(MODEL),
  ]);
  const players = Object.entries(corpus);
  if (players.length !== 60) throw new Error(`Expected cached 60-player corpus, found ${players.length}.`);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"] });
  const vocabIndex = new Map(vocab.map((uci, i) => [uci, i]));
  const totals = blank();
  const perPlayer: PlayerResult[] = [];
  try {
    for (const [playerIndex, [username, player]] of players.entries()) {
      const games = [...player.games].sort((a, b) => a.createdAt - b.createdAt);
      if (games.length < TRAIN_GAMES + TEST_GAMES) throw new Error(`${username} has only ${games.length} cached games.`);
      const training = games.slice(0, TRAIN_GAMES);
      const test = games.slice(-TEST_GAMES);
      const tree = emptyOpeningTree(username);
      for (const game of training) updateOpeningTree(tree, game.id, game.moves, game.playerColor, 40);
      argumentsTree = tree;
      const rows = blank();
      console.log(`[${playerIndex + 1}/60] ${username}: 64 train / 20 test`);
      for (const game of test) {
        const chess = new Chess();
        for (let ply = 0; ply < game.moves.length; ply++) {
          const fen = chess.fen();
          const isTargetMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
          let actual;
          try { actual = chess.move(game.moves[ply]); } catch { break; }
          if (!isTargetMove) continue;
          const logits = await infer(session, fen, game.playerRating ?? player.rating, game.opponentRating);
          const base = topLegalMove(fen, logits, vocabIndex);
          if (!base) continue;
          const tree = ply < 12 ? openingTreeMove(argumentsTree, fen) : null;
          const chosen = tree ?? base;
          const actualUci = actual.from + actual.to + (actual.promotion ?? "");
          const p = phase(ply), row = rows[p], total = totals[p];
          row.total++; total.total++;
          if (base === actualUci) { row.baseCorrect++; total.baseCorrect++; }
          if (chosen === actualUci) { row.shippedCorrect++; total.shippedCorrect++; }
          if (tree) { row.treeMatches++; total.treeMatches++; }
        }
      }
      perPlayer.push({ username, phases: rows });
    }
  } finally { await session.release(); }
  const report = { generatedAt: new Date().toISOString(), corpus: "cached chronological 60-opponent corpus", split: { training: TRAIN_GAMES, test: TEST_GAMES }, route: "opening tree for ply < 12 when exact position match exists; otherwise rating-conditioned Base Maia top legal move; reranker disabled", totals, players: perPlayer };
  await mkdir(join(ROOT, "artifacts/evaluation"), { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# Shipped baseline: opening-tree mimicry + Base Maia",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "Chronological holdout: oldest 64 games build each opening tree; newest 20 games are evaluated. The reranker is disabled. Maia is evaluated at each opponent's recorded rating, and its highest-logit legal move is used whenever no opening-tree move applies.",
    "",
    "| Phase | Positions | Base Maia | Shipped route | Tree matches |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const p of PHASES) { const c = totals[p]; lines.push(`| ${p} | ${c.total} | ${pct(c.baseCorrect, c.total)} | ${pct(c.shippedCorrect, c.total)} | ${c.treeMatches} |`); }
  const all = PHASES.reduce((a, p) => { const c = totals[p]; a.total += c.total; a.base += c.baseCorrect; a.shipped += c.shippedCorrect; a.matches += c.treeMatches; return a; }, { total: 0, base: 0, shipped: 0, matches: 0 });
  lines.push(`| **Overall** | **${all.total}** | **${pct(all.base, all.total)}** | **${pct(all.shipped, all.total)}** | **${all.matches}** |`, "", "## Per-opponent accuracy", "", "| Opponent | Middlegame positions | Base Maia | Shipped route | Delta |", "|---|---:|---:|---:|---:|");
  for (const player of perPlayer) { const c = player.phases[PHASES[1]], delta = c.total ? 100 * (c.shippedCorrect - c.baseCorrect) / c.total : 0; lines.push(`| ${player.username} | ${c.total} | ${pct(c.baseCorrect, c.total)} | ${pct(c.shippedCorrect, c.total)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pp |`); }
  lines.push("");
  await writeFile(OUT_MD, `${lines.join("\n")}\n`);
  console.log(`\n${lines.slice(7, 12).join("\n")}`);
  console.log(`Saved ${OUT_MD} and ${OUT_JSON}`);
}

// Keep the tree in scope for the position loop while each player gets a fresh training-only instance.
let argumentsTree = emptyOpeningTree("evaluation");
main().catch((error: unknown) => { console.error("Shipped baseline evaluation failed:", error); process.exitCode = 1; });
