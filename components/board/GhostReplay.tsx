"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessgroundBoard from "./ChessgroundBoard";
import GameReplay from "./GameReplay";
import PositionSpar from "./PositionSpar";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import { evalFen, evalFenMultiPv, type EvalResult } from "@/lib/eval/stockfishEngine";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import type { GhostMoment } from "@/lib/ghost/getGhostMoment";
import { generateEngineBaseline, generateMaiaVsEngine } from "@/lib/ghost/generateProgression";
import { getCachedProgression, putCachedProgression, type CachedProgression, type ProgressionLine } from "@/lib/ghost/progressionCache";

type ProgressionContent = Omit<CachedProgression, "key" | "version" | "generatedAt">;

const NEUTRAL_FEATURES: OpponentFeatures = {
  username: "", gamesAnalyzed: 0, mostCommonOpenings: [], queenTradeRate: 0.5,
  aggressionIndex: 0.5, avgRating: null, fetchedAt: 0,
};

interface ReplayLine {
  label: string;
  san: string | null;
  fen: string | null;
  detail: string | null;
  from?: Key;
  to?: Key;
}

interface PlayerPerspectiveEval {
  cp: number | null;
  mate: number | null;
}

function playerPerspectiveEval(result: EvalResult | null, fen: string, playerColor: "white" | "black"): PlayerPerspectiveEval | null {
  if (!result || (result.cp === null && result.mate === null)) return null;
  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  const sign = turn === playerColor ? 1 : -1;
  return {
    cp: result.cp === null ? null : result.cp * sign,
    mate: result.mate === null ? null : result.mate * sign,
  };
}

function formatPlayerEval(score: PlayerPerspectiveEval | null): string {
  if (!score) return "Evaluation unavailable";
  if (score.mate !== null) {
    if (score.mate === 0) return "Checkmate position";
    return `Mate in ${Math.abs(score.mate)} ${score.mate > 0 ? "for you" : "against you"}`;
  }
  if (score.cp === null) return "Evaluation unavailable";
  const pawns = score.cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)} pawns for you`;
}

function comparePlayerEvals(played: PlayerPerspectiveEval | null, engine: PlayerPerspectiveEval | null): string {
  if (!played || !engine) return "Played-vs-Stockfish comparison unavailable.";
  if (played.mate !== null || engine.mate !== null) {
    return "Mate score present; a centipawn delta would be misleading. Compare the normalized mate results above.";
  }
  if (played.cp === null || engine.cp === null) return "Played-vs-Stockfish comparison unavailable.";
  const delta = engine.cp - played.cp;
  if (Math.abs(delta) < 5) return "Stockfish and your move have nearly the same resulting evaluation.";
  return delta > 0
    ? `Stockfish's move improves the resulting evaluation by ${(delta / 100).toFixed(2)} pawns.`
    : `Your move's resulting evaluation is ${(-delta / 100).toFixed(2)} pawns better at this search depth.`;
}

type BoardSquare = Key;

function lineFromUci(fenBefore: string, uci: string | null): { san: string; fen: string; from: BoardSquare; to: BoardSquare } | null {
  if (!uci || uci.length < 4) return null;
  const chess = new Chess(fenBefore);
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return move ? { san: move.san, fen: chess.fen(), from: move.from as BoardSquare, to: move.to as BoardSquare } : null;
  } catch {
    return null;
  }
}

function replayLine(fenBefore: string, san: string): string | null {
  const chess = new Chess(fenBefore);
  try { return chess.move(san) ? chess.fen() : null; } catch { return null; }
}

function lineFromSan(fenBefore: string, san: string): { fen: string; from: BoardSquare; to: BoardSquare } | null {
  const chess = new Chess(fenBefore);
  try {
    const move = chess.move(san);
    return move ? { fen: chess.fen(), from: move.from as BoardSquare, to: move.to as BoardSquare } : null;
  } catch { return null; }
}

function positionAtPly(moves: string[], ply: number): { fen: string; invalidPly: number | null } {
  const chess = new Chess();
  for (let index = 0; index < ply; index++) {
    try {
      if (!chess.move(moves[index])) return { fen: chess.fen(), invalidPly: index };
    } catch { return { fen: chess.fen(), invalidPly: index }; }
  }
  return { fen: chess.fen(), invalidPly: null };
}

function continuationPlyLabel(startingFen: string, ply: number, playerColor: "white" | "black") {
  const fields = startingFen.split(" ");
  let fullmove = Number.parseInt(fields[5] ?? "1", 10) || 1;
  let color: "white" | "black" = fields[1] === "b" ? "black" : "white";
  for (let index = 0; index < ply; index++) {
    if (color === "black") fullmove++;
    color = color === "white" ? "black" : "white";
  }
  return `${fullmove}${color === "black" ? "..." : "."} ${color === playerColor ? "You" : "Opponent"}`;
}

export default function GhostReplay({ moment }: { moment: GhostMoment }) {
  const { infer } = useMaiaWorker(true);
  const [lines, setLines] = useState<ReplayLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSpar, setShowSpar] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [progression, setProgression] = useState<ProgressionContent | null>(null);
  const [progressionStage, setProgressionStage] = useState<string | null>(null);
  const [progressionError, setProgressionError] = useState<string | null>(null);
  const [progressionNotice, setProgressionNotice] = useState<string | null>(null);
  const [progressionFeedbackKey, setProgressionFeedbackKey] = useState<string | null>(null);
  const [activeProgressionLine, setActiveProgressionLine] = useState<ProgressionLine | null>(null);
  const [sparFromProgressionFen, setSparFromProgressionFen] = useState<string | null>(null);
  const progressionRequestRef = useRef(0);
  const continuationRequestedRef = useRef(false);
  const [currentPly, setCurrentPly] = useState(moment.ply);
  const { fen: currentFen, invalidPly } = useMemo(() => positionAtPly(moment.moves, currentPly), [moment.moves, currentPly]);
  const currentSan = moment.moves[currentPly] ?? null;
  const isGameFinished = currentPly >= moment.moves.length;
  const predictionsAgree = Boolean(lines?.[1]?.san && lines[1].san === lines[2]?.san);
  const movingColor = currentFen.split(" ")[1] === "b" ? "black" : "white";
  const maiaRating = movingColor === moment.playerColor ? moment.playerRating : moment.opponentRating;
  const opponentRating = movingColor === moment.playerColor ? moment.opponentRating : moment.playerRating;
  const continuationPositionKey = `${moment.gameId}:${currentPly}:${currentFen}:${maiaRating ?? "default"}`;
  const showProgressionFeedback = progressionFeedbackKey === continuationPositionKey;
  const currentProgressionStage = showProgressionFeedback ? progressionStage : null;
  const currentProgressionError = showProgressionFeedback ? progressionError : null;
  const currentProgressionNotice = showProgressionFeedback ? progressionNotice : null;
  const visibleProgression = progression?.ply === currentPly && progression.startingFen === currentFen ? progression : null;

  function navigateToPly(ply: number) {
    setActiveProgressionLine(null);
    setCurrentPly(ply);
  }

  useEffect(() => () => { progressionRequestRef.current++; }, []);

  const generateContinuation = useCallback(async (force = false) => {
    if (currentPly >= moment.moves.length || new Chess(currentFen).isGameOver()) return;
    const request = ++progressionRequestRef.current;
    const startingPly = currentPly;
    const startingFen = currentFen;
    const predictedColor = movingColor;
    const predictedRating = maiaRating;
    const otherRating = opponentRating;
    setProgressionFeedbackKey(continuationPositionKey);
    setProgressionStage(force ? "Regenerating the continuation…" : "Checking this browser for a saved continuation…");
    setProgressionError(null);
    setProgressionNotice(null);
    try {
      const cached = force ? null : await getCachedProgression(moment.gameId, startingPly).catch(() => null);
      if (request !== progressionRequestRef.current) return;
      if (cached && cached.startingFen === startingFen && cached.userRating === predictedRating) {
        setProgression(cached);
        setProgressionNotice("Loaded from this browser’s saved continuations.");
        setProgressionStage(null);
        return;
      }

      setProgression(null);
      setProgressionStage("Generating Stockfish baseline…");
      const engineLine = await generateEngineBaseline(startingFen, moment.playerColor);
      if (request !== progressionRequestRef.current) return;
      setProgressionStage("Generating Maia prediction and Stockfish replies…");
      const maiaLine = await generateMaiaVsEngine(
        startingFen,
        predictedColor,
        predictedRating,
        otherRating,
        infer,
        moment.playerColor,
      );
      if (request !== progressionRequestRef.current) return;

      const generated = {
        gameId: moment.gameId,
        ply: startingPly,
        startingFen,
        userRating: predictedRating,
        lines: [engineLine, maiaLine] as [ProgressionLine, ProgressionLine],
      };
      setProgression(generated);
      setProgressionStage("Saving this continuation on this device…");
      try {
        await putCachedProgression(generated);
        setProgressionNotice("Saved in this browser. Continuations do not sync across devices.");
      } catch {
        setProgressionNotice("Continuation generated, but this browser could not save a local copy.");
      }
      if (request === progressionRequestRef.current) setProgressionStage(null);
    } catch (err) {
      if (request !== progressionRequestRef.current) return;
      setProgressionError(err instanceof Error ? err.message : "Could not generate a continuation.");
      setProgressionStage(null);
    }
  }, [continuationPositionKey, currentFen, currentPly, infer, maiaRating, moment.gameId, moment.moves.length, moment.playerColor, movingColor, opponentRating]);

  useEffect(() => {
    const request = ++progressionRequestRef.current;
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    if (currentPly >= moment.moves.length || new Chess(currentFen).isGameOver()) return () => { cancelled = true; };

    void getCachedProgression(moment.gameId, currentPly).then((cached) => {
      if (cancelled || request !== progressionRequestRef.current) return;
      if (cached && cached.startingFen === currentFen && cached.userRating === maiaRating) {
        setProgression(cached);
        setProgressionFeedbackKey(continuationPositionKey);
        setProgressionStage(null);
        setProgressionError(null);
        setProgressionNotice("Loaded from this browser’s saved continuations.");
      } else if (continuationRequestedRef.current) {
        debounceTimer = setTimeout(() => {
          if (!cancelled && request === progressionRequestRef.current) void generateContinuation(false);
        }, 250);
      }
    }).catch(() => {
      if (!cancelled && request === progressionRequestRef.current && continuationRequestedRef.current) {
        debounceTimer = setTimeout(() => {
          if (!cancelled && request === progressionRequestRef.current) void generateContinuation(false);
        }, 250);
      }
    });
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [continuationPositionKey, currentFen, currentPly, generateContinuation, maiaRating, moment.gameId, moment.moves.length]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLines(null);
      setError(null);
      if (currentPly >= moment.moves.length) return;
      const maiaPromise = infer(currentFen, maiaRating, opponentRating).then((inference) =>
        rerankMoves({ fen: currentFen, logitsMaia: inference.logitsMaia, opponentFeatures: NEUTRAL_FEATURES })
      );
      const [stockfishResult, maiaResult] = await Promise.allSettled([
        evalFenMultiPv(currentFen, 1),
        maiaPromise,
      ]);
      if (cancelled) return;

      const playedFen = currentSan ? replayLine(currentFen, currentSan) : null;
      const playedMove = currentSan ? lineFromSan(currentFen, currentSan) : null;
      const stockfish = stockfishResult.status === "fulfilled" ? stockfishResult.value[0] : null;
      const sfMove = lineFromUci(currentFen, stockfish?.uci ?? null);
      const maia = maiaResult.status === "fulfilled" ? maiaResult.value.baseTopMove : null;
      const maiaMove = lineFromUci(currentFen, maia?.uci ?? null);
      const issues = [
        stockfishResult.status === "rejected" ? "Stockfish unavailable" : null,
        maiaResult.status === "rejected" ? "Maia unavailable" : null,
      ].filter(Boolean).join("; ");
      const positionFens = [playedFen, sfMove?.fen ?? null, maiaMove?.fen ?? null];
      const positionEvals = await Promise.allSettled([
        positionFens[0] ? evalFen(positionFens[0]) : Promise.resolve(null),
        positionFens[1] ? evalFen(positionFens[1]) : Promise.resolve(null),
        positionFens[2] ? evalFen(positionFens[2]) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const scoreAt = (index: number) => {
        const result = positionEvals[index];
        const fen = positionFens[index];
        return fen && result.status === "fulfilled"
          ? playerPerspectiveEval(result.value, fen, moment.playerColor)
          : null;
      };
      const playedEval = scoreAt(0);
      const stockfishEval = scoreAt(1);
      const maiaEval = scoreAt(2);
      setLines([
        { label: "Game move", san: currentSan, fen: playedFen, detail: `Stockfish after move: ${formatPlayerEval(playedEval)}.${currentPly === moment.ply ? ` Saved analysis recorded ${Math.round(moment.cpLoss)} cp loss.` : ""}`, from: playedMove?.from, to: playedMove?.to },
        { label: "Stockfish top choice", san: sfMove?.san ?? null, fen: sfMove?.fen ?? null, detail: `Stockfish after move: ${formatPlayerEval(stockfishEval)}.`, from: sfMove?.from, to: sfMove?.to },
        { label: `Maia prediction at ${maiaRating ?? "unknown"} rating`, san: maiaMove?.san ?? null, fen: maiaMove?.fen ?? null, detail: maia ? `Maia predicts this move; Stockfish after the predicted move: ${formatPlayerEval(maiaEval)}.` : issues || "No legal Maia choice available", from: maiaMove?.from, to: maiaMove?.to },
      ]);
      if (playedEval && stockfishEval) {
        setLines((current) => current?.map((line, index) => index === 0
          ? { ...line, detail: `${line.detail} ${comparePlayerEvals(playedEval, stockfishEval)}` }
          : line) ?? current);
      }
      const unavailableEvaluations = positionEvals.some((result, index) =>
        positionFens[index] !== null && result.status === "rejected"
      );
      const visibleIssues = [issues, unavailableEvaluations ? "One or more resulting-position evaluations are unavailable" : null]
        .filter(Boolean).join("; ");
      if (visibleIssues) setError(visibleIssues);
    }

    void run().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Ghost replay failed to load.");
    });
    return () => { cancelled = true; };
  }, [moment, infer, currentFen, currentPly, currentSan, maiaRating, opponentRating]);

  return <div>
    {error && <p role="status" className="mb-4 text-sm text-amber-200">{error}. Available lines are shown below.</p>}
    {invalidPly !== null && <p role="status" className="mb-3 text-xs text-amber-200">The saved move list is invalid at ply {invalidPly + 1}; replay stops before that move.</p>}
    <div className="mx-auto max-w-[560px]">
      <nav className="mb-3 flex items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3 py-2" aria-label="Game move navigation">
        <span className="font-mono text-xs text-neutral-400">{currentPly === moment.moves.length ? "Game end" : `Move ${Math.floor(currentPly / 2) + 1} · ${movingColor} to move`} <span className="text-neutral-600">({currentPly}/{moment.moves.length})</span></span>
        <span className="flex gap-1">
          <button type="button" onClick={() => navigateToPly(Math.max(0, currentPly - 1))} disabled={currentPly === 0} aria-label="Previous move" className="rounded border border-white/10 px-3 py-1 text-sm text-neutral-200 hover:bg-white/10 disabled:text-neutral-700">←</button>
          <button type="button" onClick={() => navigateToPly(Math.min(moment.moves.length, currentPly + 1))} disabled={currentPly >= moment.moves.length} aria-label="Next move" className="rounded border border-white/10 px-3 py-1 text-sm text-neutral-200 hover:bg-white/10 disabled:text-neutral-700">→</button>
        </span>
      </nav>
      {isGameFinished ? <>
        <ChessgroundBoard fen={currentFen} orientation={moment.playerColor} />
        <p role="status" className="mt-3 text-sm text-neutral-400">Game finished. There are no next moves to predict from this position.</p>
      </> : !lines ? <><ChessgroundBoard fen={currentFen} orientation={moment.playerColor} /><p className="mt-3 text-xs text-neutral-400">Loading Stockfish and Maia choices…</p></> : <>
      <ChessgroundBoard fen={currentFen} orientation={moment.playerColor}
        ghostLayers={[
          ...(lines[1]?.fen ? [{ fen: lines[1].fen, tint: "#60a5fa", label: "Stockfish" }] : []),
          ...(lines[2]?.fen && lines[2].fen !== lines[1]?.fen ? [{ fen: lines[2].fen, tint: "#f472b6", label: "Maia" }] : []),
        ]}
        ghostArrows={[
          ...(lines[1]?.from && lines[1]?.to ? [{ from: lines[1].from, to: lines[1].to, tint: "#60a5fa", label: "Stockfish" }] : []),
          ...(lines[2]?.from && lines[2]?.to ? [{ from: lines[2].from, to: lines[2].to, tint: "#f472b6", label: "Maia" }] : []),
        ]} />
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <p className="text-sky-300"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-sky-400" />Stockfish: <strong>{lines[1]?.san ?? "unavailable"}</strong></p>
        <p className="text-pink-300"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-pink-400" />Maia: <strong>{lines[2]?.san ?? "unavailable"}</strong> <span className="text-xs text-neutral-500">(behavior prediction)</span></p>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{currentSan ? `Game move: ${currentSan}.` : "No game move from this position."} {predictionsAgree ? "Stockfish and Maia agree on this move; both colored arrows mark the shared prediction." : "Blue arrow and ghost piece show Stockfish's top move; pink arrow and ghost piece show Maia's behavior prediction."} A ghost piece marks its hypothetical destination.</p>
      {!isGameFinished && <div className="mt-3 flex justify-end">
        <button type="button" onClick={() => setCompareOpen(true)} className="rounded border border-white/10 px-2.5 py-1 text-[11px] text-neutral-400 hover:text-white">Compare boards</button>
      </div>}
      </>}
    </div>
    {compareOpen && typeof document !== "undefined" && createPortal(
      <div className="fixed inset-0 z-[1000] overflow-y-auto bg-black/85 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompareOpen(false); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="ghost-compare-title" className="mx-auto my-8 max-w-6xl rounded-2xl border border-white/10 bg-[#11110f] p-4 shadow-2xl sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div><h2 id="ghost-compare-title" className="text-sm font-medium text-white">Compare predictions</h2><p className="mt-1 text-xs text-neutral-500">Move navigation stays synced with the main board.</p></div>
            <button type="button" onClick={() => setCompareOpen(false)} className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Close</button>
          </div>
          <nav className="mb-4 flex items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3 py-2" aria-label="Game move navigation">
            <span className="font-mono text-xs text-neutral-400">{currentPly === moment.moves.length ? "Game end" : `Move ${Math.floor(currentPly / 2) + 1} · ${movingColor} to move`} <span className="text-neutral-600">({currentPly}/{moment.moves.length})</span></span>
            <span className="flex gap-1">
              <button type="button" onClick={() => navigateToPly(Math.max(0, currentPly - 1))} disabled={currentPly === 0} aria-label="Previous move" className="rounded border border-white/10 px-3 py-1 text-sm text-neutral-200 hover:bg-white/10 disabled:text-neutral-700">←</button>
              <button type="button" onClick={() => navigateToPly(Math.min(moment.moves.length, currentPly + 1))} disabled={currentPly >= moment.moves.length} aria-label="Next move" className="rounded border border-white/10 px-3 py-1 text-sm text-neutral-200 hover:bg-white/10 disabled:text-neutral-700">→</button>
            </span>
          </nav>
          {isGameFinished ? <>
            <div className="mx-auto max-w-[560px]"><ChessgroundBoard fen={currentFen} orientation={moment.playerColor} /></div>
            <p role="status" className="py-6 text-center text-sm text-neutral-400">Game finished. There are no next moves to predict from this position.</p>
          </> : !lines ? <p className="py-12 text-center text-sm text-neutral-400">Loading Stockfish and Maia choices…</p> : <>
          <div className="mx-auto mb-5 max-w-[560px]">
            <ChessgroundBoard fen={currentFen} orientation={moment.playerColor}
              ghostLayers={[
                ...(lines[1]?.fen ? [{ fen: lines[1].fen, tint: "#60a5fa", label: "Stockfish" }] : []),
                ...(lines[2]?.fen && lines[2].fen !== lines[1]?.fen ? [{ fen: lines[2].fen, tint: "#f472b6", label: "Maia" }] : []),
              ]}
              ghostArrows={[
                ...(lines[1]?.from && lines[1]?.to ? [{ from: lines[1].from, to: lines[1].to, tint: "#60a5fa", label: "Stockfish" }] : []),
                ...(lines[2]?.from && lines[2]?.to ? [{ from: lines[2].from, to: lines[2].to, tint: "#f472b6", label: "Maia" }] : []),
              ]} />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {lines.map((line, index) => <div key={line.label} className="rounded-xl border border-white/10 bg-black/30 p-3">
              <p className="text-xs text-neutral-400">{line.label}</p>
              {line.fen ? <div className="mt-2"><ChessgroundBoard fen={line.fen} orientation={moment.playerColor} /></div> : <p className="mt-2 aspect-square content-center text-xs text-neutral-600">Unavailable</p>}
              <p className="mt-2 font-mono text-sm text-white">{line.san ?? "—"}</p>
              {line.detail && <p className="mt-1 text-xs text-neutral-400">{line.detail}</p>}
              {index === 2 && <p className="mt-1 text-[10px] text-pink-300/80">Behavior prediction, not an engine evaluation.</p>}
            </div>)}
          </div>
          </>}
        </section>
      </div>,
      document.body,
    )}

    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" onClick={() => setShowSpar((shown) => !shown)} aria-expanded={showSpar} className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-200 hover:bg-amber-400/20">
        {showSpar ? "Close spar" : "Drill this position"}
      </button>
      <Link href={`/dashboard/games/${encodeURIComponent(moment.gameId)}?ply=${currentPly}`} className="inline-flex items-center rounded-lg border border-white/10 px-4 py-2 text-xs text-neutral-300 hover:bg-white/10">Replay full game from here</Link>
    </div>

    <section className="mt-7 border-t border-white/10 pt-5" aria-labelledby="ghost-progression-title">
      <div className="max-w-2xl">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">What happens next</p>
        <h2 id="ghost-progression-title" className="mt-2 text-lg font-medium text-neutral-100">Explore a short continuation</h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Project the next three full moves for you and your opponent. Generate once to update the lines as you move through the game.</p>
        {!isGameFinished && <p className="mt-2 font-mono text-[11px] text-neutral-400">Starting from ply {currentPly} · {movingColor} to move</p>}
      </div>
      {!isGameFinished && <button type="button" onClick={() => { continuationRequestedRef.current = true; void generateContinuation(!!visibleProgression); }} disabled={currentProgressionStage !== null} className="mt-4 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-xs text-emerald-100 hover:bg-emerald-300/15 disabled:cursor-wait disabled:opacity-60">
        {currentProgressionStage ? "Working…" : visibleProgression ? "Regenerate Continuation" : "Generate Continuation"}
      </button>}
      {isGameFinished && <p className="mt-4 text-xs text-neutral-400">Game finished. There are no next moves to continue from this position.</p>}
      {currentProgressionStage && <p className="mt-2 text-xs text-neutral-400" role="status" aria-live="polite">{currentProgressionStage}</p>}
      {currentProgressionError && <p className="mt-2 text-xs text-amber-200" role="alert">{currentProgressionError}</p>}
      {currentProgressionNotice && <p className="mt-2 text-xs text-neutral-500" role="status">{currentProgressionNotice}</p>}

      {visibleProgression && <div className="mt-5 space-y-3">
        {visibleProgression.lines.map((line) => <button key={line.id} type="button" onClick={() => setActiveProgressionLine(line)} disabled={line.moves.length === 0} className="block w-full rounded-xl border border-white/10 bg-black/25 p-4 text-left transition hover:border-white/20 hover:bg-white/[0.03] disabled:cursor-default disabled:opacity-60">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-neutral-100">{line.label}</span>
            {line.decisive && <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[10px] text-amber-200">Decisive evaluation in line</span>}
          </span>
          <span className="mt-1 block text-xs leading-5 text-neutral-500">{line.description}</span>
          <span className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label={`${line.moves.length}-ply continuation timeline`}>
            {line.moves.map((move, index) => <span key={`${index}-${move.uci}`} className="min-w-14 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-center font-mono text-xs text-neutral-200" style={{ opacity: index < 2 ? 1 : index < 4 ? 0.8 : 0.5 }}>
              <span className="block text-[9px] text-neutral-500">{continuationPlyLabel(visibleProgression.startingFen, index, moment.playerColor)}</span>{move.san}
            </span>)}
          </span>
          {line.stopReason && <span className={`mt-2 block text-[11px] ${line.decisive ? "text-amber-200/80" : "text-neutral-500"}`}>{line.stopReason}</span>}
        </button>)}
        <p className="text-[11px] text-neutral-500">Predictions degrade the further they run from the actual game. Move tiles fade to show that uncertainty.</p>
        <p className="text-[10px] text-neutral-600">Generated continuations are saved in this browser only and do not sync across devices.</p>
      </div>}
    </section>

    {activeProgressionLine && visibleProgression && createPortal(
      <div className="fixed inset-0 z-[1100] overflow-y-auto bg-black/85 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveProgressionLine(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="progression-review-title" className="mx-auto my-5 max-w-6xl rounded-2xl border border-white/10 bg-[#11110f] p-4 shadow-2xl sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id="progression-review-title" className="text-base font-medium text-white">{activeProgressionLine.label}</h2>
              <p className="mt-1 text-xs text-neutral-400">{activeProgressionLine.description}</p>
              {activeProgressionLine.id === "maia" && <p className="mt-1 text-[11px] text-pink-300/80">Maia behavior prediction, not a recorded game or certainty about how you would play.</p>}
            </div>
            <button type="button" onClick={() => setActiveProgressionLine(null)} className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Close</button>
          </div>
          <GameReplay
            gameId={`${moment.gameId}-${currentPly}-continuation-${activeProgressionLine.id}`}
            moves={activeProgressionLine.moves.map((move) => move.san)}
            pgn={activeProgressionLine.pgn}
            flags={[]}
            playerColor={movingColor}
            maiaRating={opponentRating}
            humanRating={maiaRating}
            opponentUsername={moment.opponentUsername}
            effectiveRatingFires={moment.effectiveRatingFires}
            initialFen={visibleProgression.startingFen}
            showSparControls={false}
          />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <p className="text-[11px] text-neutral-500">Stockfish evaluations use browser-side analysis. Maia&apos;s moves are rating-conditioned behavioral predictions.</p>
            <button type="button" onClick={() => {
              const finalMove = activeProgressionLine.moves[activeProgressionLine.moves.length - 1];
              setSparFromProgressionFen(finalMove?.fen ?? visibleProgression.startingFen);
              setActiveProgressionLine(null);
            }} className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-xs text-emerald-100 hover:bg-emerald-300/15">Spar from this position</button>
          </div>
        </section>
      </div>,
      document.body,
    )}
    {sparFromProgressionFen && <div className="mt-5"><PositionSpar key={sparFromProgressionFen} fen={sparFromProgressionFen} humanColor={moment.playerColor} maiaRating={moment.opponentRating} humanRating={moment.playerRating} opponentUsername={moment.opponentUsername} effectiveRatingFires={moment.effectiveRatingFires} resolution={null} showPreviewBoard={false} autoStart /></div>}
    {showSpar && <div className="mt-5 max-w-[420px]"><PositionSpar fen={currentFen} humanColor={moment.playerColor} maiaRating={moment.opponentRating} humanRating={moment.playerRating} opponentUsername={moment.opponentUsername} effectiveRatingFires={moment.effectiveRatingFires} resolution={currentPly === moment.ply ? { gameId: moment.gameId, ply: moment.ply } : null} showPreviewBoard={false} /></div>}
  </div>;
}
