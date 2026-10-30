"use client";

import { useState } from "react";
import { Chess } from "chess.js";
import { emptyOpeningTree, updateOpeningTree } from "@/lib/profile/openingTree";
import { buildOpponentFeaturesFromGames } from "@/lib/lichess/opponentFeatures";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import type { OpeningTree, ParsedGame } from "@/types";

const SELECTED_OPPONENTS = 2;
const MAX_POSITIONS_PER_OPPONENT = 100;
type Phase = "opening" | "middlegame" | "endgame";
type MetricBucket = { baseHits: number; mimicHits: number; gained: number; lost: number; positions: number };
type StyleDimension = "capture" | "check" | "queenCapture";
type StyleTotals = Record<StyleDimension, number>;
type StyleBucket = { positions: number; observed: StyleTotals; baseExpected: StyleTotals; adjustedExpected: StyleTotals };
type Candidate = { username: string; trainGames: ParsedGame[]; heldOutGames: ParsedGame[]; opening: OpeningTree; opponentFeatures: ReturnType<typeof buildOpponentFeaturesFromGames>; aggressionIndex: number; queenTradeRate: number; forcingMoveRate: number; sacrifices: { evaluatedEvents: number; compensated: number; blunders: number; uncertain: number } };
type OpponentResult = { username: string; buildGames: number; heldOutGames: number; aggressionIndex: number; queenTradeRate: number; forcingMoveRate: number; sacrifices: Candidate["sacrifices"]; byPhase: Record<Phase, MetricBucket>; styleByPhase: Record<Phase, StyleBucket> };
const PHASES: Phase[] = ["opening", "middlegame", "endgame"];
const STYLE_DIMENSIONS: StyleDimension[] = ["capture", "check", "queenCapture"];
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function emptyBucket(): MetricBucket {
  return { baseHits: 0, mimicHits: 0, gained: 0, lost: 0, positions: 0 };
}

function emptyPhases(): Record<Phase, MetricBucket> {
  return { opening: emptyBucket(), middlegame: emptyBucket(), endgame: emptyBucket() };
}

function emptyStyleTotals(): StyleTotals {
  return { capture: 0, check: 0, queenCapture: 0 };
}

function emptyStyleBucket(): StyleBucket {
  return { positions: 0, observed: emptyStyleTotals(), baseExpected: emptyStyleTotals(), adjustedExpected: emptyStyleTotals() };
}

function styleError(observed: StyleTotals, expected: StyleTotals, positions: number): number {
  if (positions === 0) return 0;
  return STYLE_DIMENSIONS.reduce((sum, dimension) =>
    sum + Math.abs(observed[dimension] / positions - expected[dimension] / positions), 0,
  ) / STYLE_DIMENSIONS.length;
}

function gamePhaseAt(chess: Chess): Phase {
  let material = 0;
  for (const row of chess.board()) for (const square of row) {
    if (square) material += PIECE_VALUES[square.type] ?? 0;
  }
  if (material / 78 <= 0.5) return "endgame";
  const fullmove = Number.parseInt(chess.fen().split(" ")[5] ?? "1", 10) || 1;
  return fullmove <= 12 ? "opening" : "middlegame";
}

function buildOpeningProfile(username: string, games: ParsedGame[]): OpeningTree {
  const opening = emptyOpeningTree(username);
  for (const game of games) {
    updateOpeningTree(opening, game.id, game.moves, game.playerColor);
  }
  return opening;
}

export default function MaiaMimicryEfficacyPage() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const { infer } = useMaiaWorker();
  const append = (line: string) => setLog((previous) => [...previous, line]);

  if (process.env.NODE_ENV === "production") {
    return <p style={{ padding: 24, fontFamily: "monospace" }}>This evaluation tool is available only in local development.</p>;
  }

  async function evaluateCandidate(candidate: Candidate): Promise<OpponentResult | null> {
    const { username, trainGames, heldOutGames, opening, opponentFeatures } = candidate;
    append(`\nEvaluating ${username} on at most ${MAX_POSITIONS_PER_OPPONENT} later-game moves...`);
    const byPhase = emptyPhases();
    const styleByPhase = { opening: emptyStyleBucket(), middlegame: emptyStyleBucket(), endgame: emptyStyleBucket() };
    for (let gameIndex = 0; gameIndex < heldOutGames.length && totalScoredPositions(byPhase) < MAX_POSITIONS_PER_OPPONENT; gameIndex++) {
      const game = heldOutGames[gameIndex];
      const chess = new Chess();
      for (let ply = 0; ply < game.moves.length && totalScoredPositions(byPhase) < MAX_POSITIONS_PER_OPPONENT; ply++) {
        const color = ply % 2 === 0 ? "white" : "black";
        const fen = chess.fen();
        const phase = gamePhaseAt(chess); // classify the position before the move
        let actual;
        try { actual = chess.move(game.moves[ply]); } catch { break; }
        if (!actual) break;
        if (color !== game.playerColor) continue;

        const bucket = byPhase[phase];
        const actualUci = actual.from + actual.to + (actual.promotion ?? "");
        try {
          const { logitsMaia } = await infer(fen, game.playerRating, game.opponentRating);
          // One inference and one rerank yield both comparators:
          // baseTopMove is Maia alone; topMove includes experimental adjustments.
          const result = await rerankMoves({
            fen,
            logitsMaia,
            opponentFeatures,
            openingTree: opening,
          });
          const baseline = result.baseTopMove?.uci ?? null;
          const mimic = result.topMove?.uci ?? null;
          bucket.positions++;
          if (baseline === actualUci) bucket.baseHits++;
          if (mimic === actualUci) bucket.mimicHits++;
          if (baseline !== actualUci && mimic === actualUci) bucket.gained++;
          if (baseline === actualUci && mimic !== actualUci) bucket.lost++;

          // Compare the opponent's actual action-feature rates with the
          // model's expected rates on the exact same held-out positions.
          // This is a paired, teacher-forced distribution diagnostic, not a
          // claim that a self-play simulation has recreated the opponent.
          const style = styleByPhase[phase];
          style.positions++;
          style.observed.capture += actual.captured ? 1 : 0;
          style.observed.check += actual.san.includes("+") || actual.san.includes("#") ? 1 : 0;
          style.observed.queenCapture += actual.captured === "q" ? 1 : 0;
          for (const move of result.moves) {
            style.baseExpected.capture += move.baseProbability * Number(move.isCapture);
            style.baseExpected.check += move.baseProbability * Number(move.isCheck);
            style.baseExpected.queenCapture += move.baseProbability * Number(move.isQueenCapture);
            style.adjustedExpected.capture += move.adjustedProbability * Number(move.isCapture);
            style.adjustedExpected.check += move.adjustedProbability * Number(move.isCheck);
            style.adjustedExpected.queenCapture += move.adjustedProbability * Number(move.isQueenCapture);
          }
        } catch (error) {
          append(`  Skipped ${game.id} ply ${ply}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const scored = totalScoredPositions(byPhase);
      append(`${username}: held-out game ${gameIndex + 1}/${heldOutGames.length}; scored positions=${scored}.`);
    }

    const total = totalScoredPositions(byPhase);
    if (total === 0) {
      append(`SKIP ${username}: no held-out positions were scored.\n`);
      return null;
    }
    const base = PHASES.reduce((sum, phase) => sum + byPhase[phase].baseHits, 0) / total;
    const mimic = PHASES.reduce((sum, phase) => sum + byPhase[phase].mimicHits, 0) / total;
    append(`${username}: training aggression index ${(candidate.aggressionIndex * 100).toFixed(1)}%; queen-trade rate ${(candidate.queenTradeRate * 100).toFixed(1)}%; capture/check proxy ${(candidate.forcingMoveRate * 100).toFixed(1)}%; exact top-1 Maia ${(base * 100).toFixed(2)}%; adjusted ${(mimic * 100).toFixed(2)}%; lift ${((mimic - base) * 100).toFixed(2)} percentage points; n=${total}.`);
    return { username, buildGames: trainGames.length, heldOutGames: heldOutGames.length, aggressionIndex: candidate.aggressionIndex, queenTradeRate: candidate.queenTradeRate, forcingMoveRate: candidate.forcingMoveRate, sacrifices: candidate.sacrifices, byPhase, styleByPhase };
  }

  function totalScoredPositions(buckets: Record<Phase, MetricBucket>): number {
    return PHASES.reduce((sum, phase) => sum + buckets[phase].positions, 0);
  }

  async function runAll() {
    setRunning(true);
    setLog([]);
    append("Reading your saved, fully evaluated games. The first 80% selects the lowest and highest opponent-aggression profiles; up to 100 later decisions per opponent are held out for the Maia comparison. No Lichess fetches or database writes are performed.\n");
    const results: OpponentResult[] = [];
    try {
      const response = await fetch("/api/debug/mimic-candidates");
      const payload = await response.json() as { error?: string; candidateCount?: number; selected?: Array<Omit<Candidate, "opening" | "opponentFeatures">> };
      if (!response.ok || !Array.isArray(payload.selected)) {
        throw new Error(payload.error ?? `Candidate profile request failed (${response.status}).`);
      }
      const selected: Candidate[] = payload.selected.map((candidate) => ({
        ...candidate,
        opening: buildOpeningProfile(candidate.username, candidate.trainGames),
        opponentFeatures: buildOpponentFeaturesFromGames(candidate.username, candidate.trainGames),
      }));
      append(`Found ${payload.candidateCount ?? 0} opponents with enough fully evaluated games. Training-set extremes by current aggression index: ${selected.map((candidate) => `${candidate.username} ${(candidate.aggressionIndex * 100).toFixed(1)}%`).join(" vs ")}.`);
      for (const candidate of selected) {
        const decisiveSacrifices = candidate.sacrifices.compensated + candidate.sacrifices.blunders;
        append(`${candidate.username}: training eval-backed material losses=${candidate.sacrifices.evaluatedEvents}; compensated=${candidate.sacrifices.compensated}; material blunders=${candidate.sacrifices.blunders}; uncertain=${candidate.sacrifices.uncertain}; decisive compensation rate=${decisiveSacrifices ? `${(100 * candidate.sacrifices.compensated / decisiveSacrifices).toFixed(1)}%` : "no decisive events"}.`);
      }
      for (const candidate of selected) {
        const result = await evaluateCandidate(candidate);
        if (result) results.push(result);
      }

      const aggregate = emptyBucket();
      const styleAggregate = emptyStyleBucket();
      for (const result of results) for (const phase of PHASES) {
        const bucket = result.byPhase[phase];
        aggregate.positions += bucket.positions;
        aggregate.baseHits += bucket.baseHits;
        aggregate.mimicHits += bucket.mimicHits;
        aggregate.gained += bucket.gained;
        aggregate.lost += bucket.lost;
        const style = result.styleByPhase[phase];
        styleAggregate.positions += style.positions;
        for (const dimension of STYLE_DIMENSIONS) {
          styleAggregate.observed[dimension] += style.observed[dimension];
          styleAggregate.baseExpected[dimension] += style.baseExpected[dimension];
          styleAggregate.adjustedExpected[dimension] += style.adjustedExpected[dimension];
        }
      }
      const macroLifts = results.map((result) => {
        const buckets = PHASES.map((phase) => result.byPhase[phase]);
        const positions = buckets.reduce((sum, bucket) => sum + bucket.positions, 0);
        const base = buckets.reduce((sum, bucket) => sum + bucket.baseHits, 0) / positions;
        const mimic = buckets.reduce((sum, bucket) => sum + bucket.mimicHits, 0) / positions;
        return mimic - base;
      });
      const macroLift = macroLifts.length ? macroLifts.reduce((sum, value) => sum + value, 0) / macroLifts.length : 0;
      const weightedLift = aggregate.positions > 0 ? (aggregate.mimicHits - aggregate.baseHits) / aggregate.positions : 0;
      append(`\n=== Exact top-1 results ===`);
      append(`Completed extreme opponents: ${results.length}/${SELECTED_OPPONENTS}; positions: ${aggregate.positions}; baseline hits: ${aggregate.baseHits}; adjusted hits: ${aggregate.mimicHits}; gained/lost: +${aggregate.gained}/-${aggregate.lost}.`);
      append(`Position-weighted lift: ${(weightedLift * 100).toFixed(2)}pp. Opponent-macro lift: ${(macroLift * 100).toFixed(2)}pp.`);
      const baseStyleError = styleError(styleAggregate.observed, styleAggregate.baseExpected, styleAggregate.positions);
      const adjustedStyleError = styleError(styleAggregate.observed, styleAggregate.adjustedExpected, styleAggregate.positions);
      append(`\n=== Held-out action-style calibration (lower is closer) ===`);
      append(`Mean absolute rate error across capture, check, and queen-capture choices: Maia ${(baseStyleError * 100).toFixed(2)}pp; opponent-adjusted ${(adjustedStyleError * 100).toFixed(2)}pp; delta ${((baseStyleError - adjustedStyleError) * 100).toFixed(2)}pp.`);
      for (const dimension of STYLE_DIMENSIONS) {
        const observed = styleAggregate.positions ? styleAggregate.observed[dimension] / styleAggregate.positions : 0;
        const baseExpected = styleAggregate.positions ? styleAggregate.baseExpected[dimension] / styleAggregate.positions : 0;
        const adjustedExpected = styleAggregate.positions ? styleAggregate.adjustedExpected[dimension] / styleAggregate.positions : 0;
        append(`  ${dimension}: observed ${(observed * 100).toFixed(1)}%; Maia expects ${(baseExpected * 100).toFixed(1)}%; adjusted expects ${(adjustedExpected * 100).toFixed(1)}%.`);
      }
      append(results.length === SELECTED_OPPONENTS
        ? macroLift >= 0.05
          ? "Result clears the requested 5pp point-estimate bar. Review per-opponent results before enabling the Mimic label."
          : "Result is below the requested 5pp point-estimate bar. Keep Base Maia as the default; the adjusted policy is not validated for a Mimic claim."
        : "INCONCLUSIVE: both selected opponents did not produce enough scored positions. Do not use this as a ship decision.");
      append("This is a small holdout point estimate, not proof of statistical significance. Style rates are measured on each real held-out position (teacher-forced), not from self-play games; capture/check features do not measure sacrifice skill or full playing style. Training-only opponent rates and opening frequencies drive the experimental adjustments; piece-usage shares are deliberately excluded.");
      append("\n=== Per-opponent, per-phase exact top-1 accuracy ===");
      for (const result of results) {
        append(`\n${result.username} (${result.buildGames} train games / ${result.heldOutGames} holdout games)`);
        for (const phase of PHASES) {
          const bucket = result.byPhase[phase];
          if (!bucket.positions) {
            append(`  ${phase}: no positions`);
            continue;
          }
          append(`  ${phase}: n=${bucket.positions}; Maia=${(100 * bucket.baseHits / bucket.positions).toFixed(1)}%; mimic=${(100 * bucket.mimicHits / bucket.positions).toFixed(1)}%; net ${bucket.gained - bucket.lost >= 0 ? "+" : ""}${bucket.gained - bucket.lost}`);
        }
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h2>Maia opponent-adjustment fidelity (local development only)</h2>
      <p>Local, authenticated read-only probe. It selects the opponents with the highest and lowest training-only aggression index from your fully evaluated saved games, then compares Maia and opponent-adjusted predictions on up to 100 chronological holdout decisions each. It also reports Stockfish-backed material-loss outcomes from training games. This is not a full self-play style test or proof of style fidelity; the checked-in ONNX model does not accept player prototypes or embeddings.</p>
      <button disabled={running} onClick={() => void runAll()}>{running ? "Running…" : "Run two-opponent probe"}</button>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}
