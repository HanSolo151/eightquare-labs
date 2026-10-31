import * as ort from "onnxruntime-web";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import { boardToTensor, mirrorUci } from "@/lib/maia/boardToTensor";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import { parseGames } from "@/lib/lichess/parseGame";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { buildOpponentProfile } from "@/lib/profile/opponentStyleProfile";
import { emptyOpeningTree, openingTreeMove, updateOpeningTree } from "@/lib/profile/openingTree";
import { gamePhaseFromFen, styleAdjustedProbabilities } from "@/lib/maia/rerank";
type Manifest = { players: Array<{ username?: string; name: string; rating: number }> };
type Phase = "Opening (<12)" | "Middlegame (12–40)" | "Endgame (>40)";
type Counts = { total: number; base: number; opening: number; hybrid: number };
type Candidate = {
  uci: string; san: string; logit: number; probability: number;
  isCheck: boolean; isCapture: boolean; isQueenCapture: boolean; isQuiet: boolean;
};

const MODEL_PATH = join(process.cwd(), "public", "models", "maia2_rapid_fp16.onnx");
const VOCAB_PATH = join(process.cwd(), "public", "data", "move_vocab.json");
const MANIFEST_PATH = join(process.cwd(), "public", "models", "maia4all_manifest.json");
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function phaseFor(ply: number): Phase {
  if (ply < 12) return "Opening (<12)";
  if (ply <= 40) return "Middlegame (12–40)";
  return "Endgame (>40)";
}

function toFloat16Bits(values: Float32Array): Uint16Array {
  const result = new Uint16Array(values.length);
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  for (let i = 0; i < values.length; i++) {
    f32[0] = values[i];
    const x = i32[0];
    let bits = (x >> 16) & 0x8000;
    let mantissa = (x >> 12) & 0x07ff;
    const exponent = (x >> 23) & 0xff;
    if (exponent < 103) result[i] = bits;
    else if (exponent > 142) result[i] = bits | 0x7c00 | (exponent === 255 && (x & 0x007fffff) ? 0x200 : 0);
    else if (exponent < 113) {
      mantissa |= 0x0800;
      result[i] = bits | ((mantissa >> (114 - exponent)) + ((mantissa >> (113 - exponent)) & 1));
    } else {
      bits |= ((exponent - 112) << 10) | (mantissa >> 1);
      bits += mantissa & 1;
      result[i] = bits;
    }
  }
  return result;
}

async function inferLogits(
  session: ort.InferenceSession,
  fen: string,
  selfRating: number | null,
  oppRating: number | null,
): Promise<Float32Array> {
  const board = boardToTensor(fen);
  const results = await session.run({
    board: new ort.Tensor("float16", toFloat16Bits(board), [1, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(selfRating))]), [1]),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from([BigInt(eloToBucket(oppRating))]), [1]),
  });
  const logits = results.logits_maia?.data;
  if (!logits || !ArrayBuffer.isView(logits)) {
    throw new Error(`Maia returned logits in an unexpected format: ${results.logits_maia?.type ?? "missing output"}.`);
  }
  return logits instanceof Float32Array ? logits : Float32Array.from(logits as unknown as ArrayLike<number>);
}

function candidatesFor(chess: Chess, logits: Float32Array, vocabIndex: Map<string, number>): Candidate[] {
  const blackToMove = chess.turn() === "b";
  const moves = chess.moves({ verbose: true });
  const candidates = moves.flatMap((move) => {
    const uci = move.from + move.to + (move.promotion ?? "");
    const modelUci = blackToMove ? mirrorUci(uci) : uci;
    const index = vocabIndex.get(modelUci);
    if (index === undefined || !Number.isFinite(logits[index])) return [];
    return [{
      uci, san: move.san, logit: logits[index], probability: 0,
      isCheck: move.san.includes("+") || move.san.includes("#"),
      isCapture: !!move.captured, isQueenCapture: move.captured === "q",
      isQuiet: !move.captured && !move.san.includes("+") && !move.san.includes("#"),
    }];
  });
  const max = Math.max(...candidates.map((candidate) => candidate.logit));
  const denominator = candidates.reduce((sum, candidate) => sum + Math.exp(candidate.logit - max), 0);
  for (const candidate of candidates) candidate.probability = Math.exp(candidate.logit - max) / denominator;
  return candidates;
}

function addDistribution(target: Map<string, number>, candidates: Candidate[], weight = 1): void {
  for (const candidate of candidates) target.set(candidate.uci, (target.get(candidate.uci) ?? 0) + candidate.probability * weight);
}

function normalize(counts: Map<string, number>): Map<string, number> {
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  return new Map([...counts].map(([key, value]) => [key, sum ? value / sum : 0]));
}

function jensenShannon(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let divergence = 0;
  for (const key of keys) {
    const pa = a.get(key) ?? 0;
    const pb = b.get(key) ?? 0;
    const mean = (pa + pb) / 2;
    if (pa > 0) divergence += 0.5 * pa * Math.log2(pa / mean);
    if (pb > 0) divergence += 0.5 * pb * Math.log2(pb / mean);
  }
  return divergence;
}

function addCount(counts: Map<Phase, Counts>, phase: Phase, actual: string, base: string, opening: string, hybrid: string): void {
  const row = counts.get(phase)!;
  row.total++;
  if (actual === base) row.base++;
  if (actual === opening) row.opening++;
  if (actual === hybrid) row.hybrid++;
}

function printTable(counts: Map<Phase, Counts>): void {
  console.log("\nHoldout top-1 accuracy (target player's moves)");
  console.log("Phase                 Positions  Base Maia  Opening only  Full hybrid");
  for (const [phase, row] of counts) {
    const pct = (n: number) => `${(100 * n / Math.max(1, row.total)).toFixed(2)}%`;
    console.log(`${phase.padEnd(21)} ${String(row.total).padStart(9)}  ${pct(row.base).padStart(9)}  ${pct(row.opening).padStart(12)}  ${pct(row.hybrid).padStart(11)}`);
  }
  const total: Counts = { total: 0, base: 0, opening: 0, hybrid: 0 };
  for (const row of counts.values()) for (const key of Object.keys(total) as (keyof Counts)[]) total[key] += row[key];
  const pct = (n: number) => `${(100 * n / Math.max(1, total.total)).toFixed(2)}%`;
  console.log(`${"Overall".padEnd(21)} ${String(total.total).padStart(9)}  ${pct(total.base).padStart(9)}  ${pct(total.opening).padStart(12)}  ${pct(total.hybrid).padStart(11)}`);
}

async function main(): Promise<void> {
  const requested = Number(process.env.EVAL_PLAYERS ?? 10);
  const [manifest, vocab, modelBytes] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8").then((raw) => JSON.parse(raw) as Manifest),
    readFile(VOCAB_PATH, "utf8").then((raw) => JSON.parse(raw) as string[]),
    readFile(MODEL_PATH),
  ]);
  if (!Number.isInteger(requested) || requested < 1) throw new Error("EVAL_PLAYERS must be a positive integer.");
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"] });
  const vocabIndex = new Map(vocab.map((uci, index) => [uci, index]));
  const phases: Phase[] = ["Opening (<12)", "Middlegame (12–40)", "Endgame (>40)"];
  const totals = new Map<Phase, Counts>(phases.map((phase) => [phase, { total: 0, base: 0, opening: 0, hybrid: 0 }]));
  const humanMiddle = new Map<string, number>();
  const baseMiddle = new Map<string, number>();
  const hybridMiddle = new Map<string, number>();
  const strengthLevels = [0.5, 1, 2, 4];
  const strengthCounts = new Map(strengthLevels.map((strength) => [strength, new Map<Phase, Counts>(phases.map((phase) => [phase, { total: 0, base: 0, opening: 0, hybrid: 0 }]))]));
  const players = manifest.players.slice(0, requested);
  console.log(`Evaluating ${players.length} prototype players with local Base Maia-2; fetching 100 recent rated rapid games each.`);

  for (const [playerIndex, player] of players.entries()) {
    const username = player.username ?? player.name;
    console.log(`[${playerIndex + 1}/${players.length}] ${username}: fetching games`);
    const raw = await fetchGames({ username, max: 100, rated: true, perfType: "rapid" });
    const games = parseGames(raw, username);
    if (games.length < 100) {
      console.warn(`  Skipping: Lichess returned ${games.length} parseable games, expected 100.`);
      continue;
    }
    // Lichess returns newest games first. Train on the older 80 and reserve
    // the newest 20 as a forward-in-time holdout.
    const training = games.slice(20, 100);
    const validation = games.slice(0, 20);
    const profile = buildOpponentProfile(training);
    const tree = emptyOpeningTree(username);
    for (const game of training) updateOpeningTree(tree, game.id, game.moves, game.playerColor);
    console.log(`  Training profile: ${profile.movesAnalyzed} post-opening moves; validating 20 held-out games.`);

    for (const game of validation) {
      const chess = new Chess();
      for (let ply = 0; ply < game.moves.length; ply++) {
        const fen = chess.fen();
        const isTargetMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
        let actualMove;
        try { actualMove = chess.move(game.moves[ply]); } catch { break; }
        if (!isTargetMove) continue;

        const logits = await inferLogits(session, fen, game.playerRating ?? player.rating, game.opponentRating);
        const candidates = candidatesFor(new Chess(fen), logits, vocabIndex);
        if (!candidates.length) continue;
        const baseChoice = candidates.reduce((best, candidate) => candidate.logit > best.logit ? candidate : best);
        const treeChoice = ply < 12 ? openingTreeMove(tree, fen) : null;
        const openingChoice = treeChoice && candidates.some((candidate) => candidate.uci === treeChoice)
          ? treeChoice : baseChoice.uci;
        const phase = phaseFor(ply);
        const useStyleReranker = phase !== "Endgame (>40)" && gamePhaseFromFen(new Chess(fen)) === "middlegame";
        const adjusted = useStyleReranker ? styleAdjustedProbabilities(candidates, profile, 0.5) : candidates;
        const hybridChoice = treeChoice && candidates.some((candidate) => candidate.uci === treeChoice)
          ? treeChoice
          : useStyleReranker
            ? adjusted.reduce((best, candidate) => candidate.probability > best.probability ? candidate : best).uci
            : baseChoice.uci;
        const actualUci = actualMove.from + actualMove.to + (actualMove.promotion ?? "");
        addCount(totals, phase, actualUci, baseChoice.uci, openingChoice, hybridChoice);

        for (const strength of strengthLevels) {
          const row = strengthCounts.get(strength)!.get(phase)!;
          const strengthChoice = treeChoice && candidates.some((candidate) => candidate.uci === treeChoice)
            ? treeChoice
            : !useStyleReranker ? baseChoice.uci : styleAdjustedProbabilities(candidates, profile, strength)
              .reduce((best, candidate) => candidate.probability > best.probability ? candidate : best).uci;
          row.total++;
          if (actualUci === strengthChoice) row.hybrid++;
        }

        if (phase === "Middlegame (12–40)") {
          addDistribution(humanMiddle, [{ ...candidates[0], uci: actualUci, probability: 1 }]);
          addDistribution(baseMiddle, [{ ...candidates[0], uci: baseChoice.uci, probability: 1 }]);
          addDistribution(hybridMiddle, [{ ...candidates[0], uci: hybridChoice, probability: 1 }]);
        }
      }
    }
  }

  printTable(totals);
  console.log("\nMiddlegame/endgame reranker strength sweep (development holdout; higher accuracy is not an independent final estimate)");
  console.log("Strength  Middlegame top-1  Endgame top-1  Overall top-1");
  for (const strength of strengthLevels) {
    const byPhase = strengthCounts.get(strength)!;
    const all = [...byPhase.values()].reduce((sum, row) => ({ total: sum.total + row.total, hybrid: sum.hybrid + row.hybrid }), { total: 0, hybrid: 0 });
    const accuracy = (phase: Phase) => {
      const row = byPhase.get(phase)!;
      return `${(100 * row.hybrid / Math.max(1, row.total)).toFixed(2)}%`;
    };
    console.log(`${strength.toFixed(1).padEnd(8)} ${accuracy("Middlegame (12–40)").padStart(17)} ${accuracy("Endgame (>40)").padStart(14)} ${(100 * all.hybrid / Math.max(1, all.total)).toFixed(2).padStart(13)}%`);
  }
  const middleN = totals.get("Middlegame (12–40)")?.total ?? 0;
  if (middleN > 0) {
    const humanDistribution = normalize(humanMiddle);
    const baseDivergence = jensenShannon(normalize(baseMiddle), humanDistribution);
    const hybridDivergence = jensenShannon(normalize(hybridMiddle), humanDistribution);
    console.log(`\nMiddlegame chosen-move divergence from humans (Jensen–Shannon, bits; lower is closer):`);
    console.log(`  Base Maia: ${baseDivergence.toFixed(4)}  |  Full Hybrid: ${hybridDivergence.toFixed(4)}  |  Change: ${(hybridDivergence - baseDivergence >= 0 ? "+" : "")}${(hybridDivergence - baseDivergence).toFixed(4)}`);
    console.log(`Samples: ${middleN} held-out target moves. This compares pooled UCI move frequencies, not position-conditioned preferences.`);
  } else {
    console.log("\nMiddlegame style divergence unavailable: no held-out middlegame moves were evaluated.");
  }
  await session.release();
}

main().catch((error: unknown) => {
  console.error("Hybrid evaluation failed:", error);
  process.exitCode = 1;
});
