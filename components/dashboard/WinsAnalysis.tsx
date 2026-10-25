"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { computeGameVectorDetails, normalizeStyleVector } from "@/lib/matching/computeGameVector";
import { findNearestBigshots } from "@/lib/matching/profileMatcher";
import { MATCHING_CONFIG } from "@/config/matching";
import { PHASES, type MatchPhase, type StyleVector, type VectorCalibration } from "@/lib/matching/vectorSchema";
import type { EvalPoint, GameEval, ParsedGame } from "@/types";

export interface WinAnalysisGame {
  id: string;
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  playerColor: "white" | "black";
  moves: string[];
  clocks: number[] | null;
  clockInitialSec: number | null;
  clockIncrementSec: number | null;
  openingName: string | null;
  openingEco: string | null;
  rated: boolean;
  speed: string | null;
  createdAt: string | null;
  evaluation: { points: EvalPoint[]; engineVersion: string; evaluatedAt: string } | null;
  evaluationStatus: string | null;
}

interface StyleProfile {
  bigshotId: string;
  bigshotName: string;
  phase: MatchPhase;
  vector: StyleVector;
}

interface PhaseResult {
  phase: MatchPhase;
  vector: StyleVector;
  normalized: StyleVector;
  closest: { bigshotId: string; name: string; distance: number } | null;
  description: string[];
}

interface MoveQuality {
  averageDrop: number;
  steadyRate: number;
  count: number;
}

interface WinResult {
  phases: PhaseResult[];
  overall: { name: string; distance: number; phaseCount: number } | null;
  qualityByPhase: Partial<Record<MatchPhase, MoveQuality>>;
  pressure: { pressured: MoveQuality; other: MoveQuality } | null;
}

export default function WinsAnalysis({
  games,
  profiles,
  calibration,
}: {
  games: WinAnalysisGame[];
  profiles: StyleProfile[];
  calibration: VectorCalibration | null;
}) {
  const [selectedId, setSelectedId] = useState(games[0]?.id ?? "");
  const selected = games.find((game) => game.id === selectedId) ?? games[0];
  const analysisState = useMemo(() => {
    if (!selected || !calibration) return { analysis: null, failed: false };
    if (!hasCompleteEvaluation(selected)) return { analysis: null, failed: false };
    try {
      return { analysis: analyzeWin(selected, profiles, calibration), failed: false };
    } catch (error) {
      console.error("Could not analyze saved win", { gameId: selected.id, error });
      return { analysis: null, failed: true };
    }
  }, [selected, profiles, calibration]);
  const analysis = analysisState.analysis;

  if (!selected) return null;

  return <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.7fr)]">
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3 pb-2">
        <div><p className="text-xs uppercase tracking-widest text-neutral-500">Saved wins</p><p className="mt-1 text-xs text-neutral-500">Pick a game to analyze</p></div>
        <span className="text-[10px] text-neutral-600">{games.length} on this page</span>
      </div>
      {games.map((game) => {
        const active = game.id === selected.id;
        const evaluated = hasCompleteEvaluation(game);
        return <button key={game.id} type="button" aria-pressed={active} onClick={() => setSelectedId(game.id)} className={`w-full rounded-xl border p-3 text-left transition-colors ${active ? "border-emerald-200/35 bg-emerald-200/[0.06]" : "border-white/10 bg-black/25 hover:border-white/20"}`}>
          <span className="flex items-center justify-between gap-3">
            <span className="truncate text-sm text-neutral-100">vs {game.opponentUsername}</span>
            <span className={`shrink-0 text-[10px] ${evaluated ? "text-emerald-200" : "text-neutral-500"}`}>{evaluated ? "ready" : game.evaluationStatus === "queued" || game.evaluationStatus === "processing" ? "analyzing" : "moves only"}</span>
          </span>
          <span className="mt-1 block truncate text-xs text-neutral-400">{game.openingName ?? "Opening not recorded"}{game.openingEco ? ` · ${game.openingEco}` : ""}</span>
          <span className="mt-2 flex gap-3 text-[10px] text-neutral-500"><span>{game.createdAt ? new Date(game.createdAt).toLocaleDateString() : "date unavailable"}</span><span>{Math.ceil(game.moves.length / 2)} moves</span><span className="capitalize">{game.speed ?? "chess"}</span></span>
        </button>;
      })}
    </section>

    <section className="min-w-0 space-y-4">
      <header className="rounded-xl border border-white/10 bg-black/35 p-4 sm:p-5">
        <p className="text-[10px] uppercase tracking-[0.22em] text-emerald-200/70">Win review · {selected.playerColor}</p>
        <h2 className="mt-2 text-xl font-semibold">vs {selected.opponentUsername}</h2>
        <p className="mt-1 text-xs text-neutral-400">{selected.openingName ?? "Opening unavailable"}{selected.openingEco ? ` · ${selected.openingEco}` : ""} · {selected.rated ? "rated" : "casual"}{selected.playerRating ? ` · your rating ${selected.playerRating}` : ""}</p>
        <p className="mt-3 text-xs leading-5 text-neutral-500">The comparison runs in this browser. Similarity is a broad style resemblance from phase-level moves; it is not a playing-strength score or an identical-line claim.</p>
        <Link href={`/dashboard/games/${encodeURIComponent(selected.id)}`} className="mt-3 inline-flex text-xs text-emerald-200 hover:text-white">Open board replay →</Link>
      </header>

      {!calibration || profiles.length !== 90 ? <section className="rounded-xl border border-amber-200/20 p-4 text-sm text-amber-100">The 30-player style library is not available.</section>
        : !analysis ? <section className="space-y-2 rounded-xl border border-white/10 bg-black/25 p-4">
          <h3 className="text-sm font-medium">Move and clock summary</h3>
          {analysisState.failed
            ? <p className="text-xs leading-5 text-neutral-400">This saved game’s moves could not be replayed for style analysis, so its comparison is unavailable. Other wins remain available to review.</p>
            : <p className="text-xs leading-5 text-neutral-400">This win has no complete saved move evaluation yet, so a calibrated player comparison and move-quality summary are unavailable. {selected.evaluationStatus === "queued" || selected.evaluationStatus === "processing" ? "Its existing game analysis is still running." : "New rated wins are evaluated after sync; older imported wins may not have a saved evaluation."}</p>}
          {!selected.clocks && <p className="text-xs text-neutral-500">This game has no clock data, so time-pressure observations are unavailable too.</p>}
        </section> : <>
          {analysis.overall && <section className="rounded-xl border border-emerald-200/20 bg-emerald-200/[0.045] p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-widest text-emerald-200/70">Whole-game style</p>
            <h3 className="mt-2 text-lg font-medium">Across {analysis.overall.phaseCount} phases, your play was closest to {analysis.overall.name}</h3>
            <p className="mt-1 text-xs leading-5 text-neutral-400">This combines each available phase’s normalized distance. A lower distance means a closer fit within this 30-player library; it is not a confidence percentage.</p>
          </section>}

          <div className="grid gap-3 md:grid-cols-3">
            {PHASES.map((phase) => {
              const result = analysis.phases.find((item) => item.phase === phase);
              return <article key={phase} className="rounded-xl border border-white/10 bg-black/30 p-4">
                <p className="text-[10px] uppercase tracking-widest text-neutral-500">{phase}</p>
                {result ? <>
                  <h3 className="mt-2 text-sm font-medium">Closest to {result.closest?.name ?? "no clear match"}</h3>
                  <p className="mt-1 text-[10px] text-neutral-500">Distance {result.closest?.distance.toFixed(2) ?? "—"}</p>
                  <ul className="mt-3 space-y-1.5 text-xs leading-5 text-neutral-400">{result.description.map((line) => <li key={line}>· {line}</li>)}</ul>
                </> : <p className="mt-2 text-xs leading-5 text-neutral-600">Not enough moves in this phase to compare.</p>}
                {analysis.qualityByPhase[phase] && <p className="mt-3 border-t border-white/10 pt-2 text-[10px] leading-4 text-neutral-500">Avg. eval drop: {analysis.qualityByPhase[phase]!.averageDrop.toFixed(2)} pawns across {analysis.qualityByPhase[phase]!.count} moves</p>}
              </article>;
            })}
          </div>

          <section className="rounded-xl border border-white/10 bg-black/30 p-4 sm:p-5">
            <p className="text-[10px] uppercase tracking-widest text-neutral-500">How this win held up</p>
            {analysis.pressure ? <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <QualityCard title="Under time pressure" quality={analysis.pressure.pressured} />
              <QualityCard title="With more time" quality={analysis.pressure.other} />
            </div> : <p className="mt-2 text-xs leading-5 text-neutral-400">Not enough clock-tagged evaluated moves to compare time-pressure decisions. When available, pressure is inferred from remaining clock and move evaluation; this is an estimate, not a rating.</p>}
            {analysis.pressure && <p className="mt-3 text-xs leading-5 text-neutral-400">{pressureTakeaway(analysis.pressure.pressured, analysis.pressure.other)}</p>}
            {phaseQualityTakeaway(analysis.qualityByPhase) && <p className="mt-2 text-xs leading-5 text-neutral-400">{phaseQualityTakeaway(analysis.qualityByPhase)}</p>}
            <p className="mt-3 text-[10px] leading-5 text-neutral-600">Move evaluation uses the saved engine score before and after your move. It describes this game only; it does not prove a lasting strength or weakness.</p>
          </section>
        </>}
    </section>
  </div>;
}

function QualityCard({ title, quality }: { title: string; quality: MoveQuality }) {
  return <div className="rounded-lg border border-white/5 bg-white/[0.025] p-3">
    <p className="text-xs text-neutral-300">{title}</p>
    <p className="mt-2 text-lg tabular-nums text-white">{quality.averageDrop.toFixed(2)} <span className="text-xs text-neutral-500">pawns average eval drop</span></p>
    <p className="mt-1 text-[10px] text-neutral-500">{Math.round(quality.steadyRate * 100)}% of {quality.count} moves stayed within 0.50 pawns</p>
  </div>;
}

function hasCompleteEvaluation(game: WinAnalysisGame): boolean {
  return Boolean(game.evaluation && game.moves.length > 0 && game.evaluation.points.length === game.moves.length);
}

function analyzeWin(game: WinAnalysisGame, profiles: StyleProfile[], calibration: VectorCalibration): WinResult | null {
  if (!hasCompleteEvaluation(game) || !game.evaluation) return null;
  const parsed: ParsedGame = {
    id: game.id,
    playerColor: game.playerColor,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    moves: game.moves,
    clocks: game.clocks,
    clockInitialSec: game.clockInitialSec,
    clockIncrementSec: game.clockIncrementSec,
    openingName: game.openingName,
    openingEco: game.openingEco,
    result: "win",
    rated: game.rated,
    speed: game.speed,
    createdAt: game.createdAt ? new Date(game.createdAt).getTime() : null,
  };
  const evaluation: GameEval = {
    gameId: game.id,
    points: game.evaluation.points,
    evaluatedAt: new Date(game.evaluation.evaluatedAt).getTime(),
    engineVersion: game.evaluation.engineVersion,
  };
  const computed = computeGameVectorDetails(parsed, evaluation);
  const byPhase: Partial<Record<MatchPhase, PhaseResult>> = {};
  const distancesByPlayer = new Map<string, { name: string; distances: number[] }>();

  for (const phase of PHASES) {
    const vector = computed.vectors[phase];
    if (!vector) continue;
    const normalized = normalizeStyleVector(vector, calibration[phase]);
    const phaseProfiles = profiles.filter((profile) => profile.phase === phase);
    const names = new Map(phaseProfiles.map((profile) => [profile.bigshotId, profile.bigshotName]));
    const nearest = findNearestBigshots(normalized, phase, phaseProfiles);
    const closest = nearest[0] ? { ...nearest[0], name: names.get(nearest[0].bigshotId) ?? "Unknown player" } : null;
    for (const match of nearest) {
      const name = names.get(match.bigshotId) ?? "Unknown player";
      const prior = distancesByPlayer.get(match.bigshotId) ?? { name, distances: [] };
      prior.distances.push(match.distance);
      distancesByPlayer.set(match.bigshotId, prior);
    }
    byPhase[phase] = {
      phase, vector, normalized, closest,
      description: describeStyle(vector, normalized, calibration[phase]),
    };
  }

  const overall = [...distancesByPlayer.values()]
    .map((player) => ({ name: player.name, phaseCount: player.distances.length, distance: Math.sqrt(player.distances.reduce((sum, distance) => sum + distance ** 2, 0) / player.distances.length) }))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
  const quality = moveQuality(game);
  return { phases: PHASES.flatMap((phase) => byPhase[phase] ? [byPhase[phase]!] : []), overall, ...quality };
}

function describeStyle(vector: StyleVector, normalized: StyleVector, phaseCalibration: VectorCalibration[MatchPhase]): string[] {
  const lines: string[] = [];
  const bucket = Math.max(0, Math.min(2, Math.round(vector.pawnStructureBucket)));
  lines.push(["A closed pawn structure", "A semi-open pawn structure", "An open pawn structure"][bucket]!);
  if (normalized.evalVolatility >= 0.65) lines.push("The evaluations swung more than the library average");
  else if (normalized.evalVolatility <= -0.65) lines.push("The phase stayed more stable than the library average");
  if (normalized.materialAggression >= 0.65) lines.push("You accepted material risk more often than the library average");
  else if (normalized.materialAggression <= -0.65) lines.push("You kept material safer than the library average");
  if (vector.kingSafetyDelta >= 0.08) lines.push("Your moves generally strengthened your pawn shelter");
  else if (vector.kingSafetyDelta <= -0.08) lines.push("Your moves generally loosened your pawn shelter");
  if (lines.length === 1) {
    const stdDev = phaseCalibration.stdDevs.pieceActivityDifferential;
    const activityZ = stdDev > 0 ? (vector.pieceActivityDifferential - phaseCalibration.means.pieceActivityDifferential) / stdDev : 0;
    lines.push(activityZ >= 0.65 ? "Your piece choices often matched the engine’s top move" : activityZ <= -0.65 ? "Your piece choices diverged from the engine’s top move more often" : "Your piece activity sat near the library average");
  }
  return lines.slice(0, 2);
}

function moveQuality(game: WinAnalysisGame): Pick<WinResult, "qualityByPhase" | "pressure"> {
  const phaseSamples = new Map<MatchPhase, number[]>();
  const pressured: number[] = [];
  const other: number[] = [];
  const points = new Map(game.evaluation!.points.map((point) => [point.ply, point]));
  const pressureLimit = Math.max(10, (game.clockInitialSec ?? 0) * 0.1);

  for (let ply = 0; ply < game.moves.length; ply++) {
    const mover = ply % 2 === 0 ? "white" : "black";
    if (mover !== game.playerColor) continue;
    const point = points.get(ply);
    if (!point || point.cpBefore === null || point.cpAfter === null) continue;
    const drop = Math.max(0, point.cpBefore - point.cpAfter) / 100;
    const phase = phaseForPly(ply);
    phaseSamples.set(phase, [...(phaseSamples.get(phase) ?? []), drop]);
    const remaining = game.clocks?.[ply];
    if (typeof remaining !== "number") continue;
    (remaining / 100 <= pressureLimit ? pressured : other).push(drop);
  }

  const summarize = (samples: number[]): MoveQuality | null => samples.length < 2 ? null : {
    averageDrop: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    steadyRate: samples.filter((value) => value <= 0.5).length / samples.length,
    count: samples.length,
  };
  const qualityByPhase = Object.fromEntries(PHASES.flatMap((phase) => {
    const summary = summarize(phaseSamples.get(phase) ?? []);
    return summary ? [[phase, summary]] : [];
  })) as Partial<Record<MatchPhase, MoveQuality>>;
  const pressureSummary = summarize(pressured);
  const otherSummary = summarize(other);
  return { qualityByPhase, pressure: pressureSummary && otherSummary ? { pressured: pressureSummary, other: otherSummary } : null };
}

function phaseForPly(ply: number): MatchPhase {
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.openingEnd) return "opening";
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.middlegameEnd) return "middlegame";
  return "endgame";
}

function pressureTakeaway(pressured: MoveQuality, other: MoveQuality): string {
  const difference = pressured.averageDrop - other.averageDrop;
  if (difference <= -0.05) return "In this win, your evaluated moves held up better under the lower clock than with more time.";
  if (difference >= 0.05) return "In this win, your estimated evaluation drops were larger under the lower clock; those moments are useful to review.";
  return "In this win, your estimated move quality was similar in the lower-clock and more-time groups.";
}

function phaseQualityTakeaway(qualityByPhase: Partial<Record<MatchPhase, MoveQuality>>): string | null {
  const phases = PHASES.flatMap((phase) => qualityByPhase[phase] ? [{ phase, quality: qualityByPhase[phase]! }] : []);
  if (!phases.length) return null;
  const mostSteady = [...phases].sort((a, b) => a.quality.averageDrop - b.quality.averageDrop)[0]!;
  const mostDifficult = [...phases].sort((a, b) => b.quality.averageDrop - a.quality.averageDrop)[0]!;
  if (mostSteady.phase === mostDifficult.phase) return `Your ${mostSteady.phase} was the most stable phase with enough evaluated moves.`;
  return `Most stable phase in this win: ${mostSteady.phase}. Largest average evaluation drops: ${mostDifficult.phase}.`;
}
