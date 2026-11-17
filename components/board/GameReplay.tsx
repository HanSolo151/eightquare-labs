"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import PositionSpar from "./PositionSpar";
import ChessgroundBoard from "./ChessgroundBoard";
import ComparePanel from "./ComparePanel";
import LiveGameContext from "./LiveGameContext";
import type { EvalPoint } from "@/types";

interface ReplayFlag {
  ply: number;
  san: string;
  severity: string;
  flagType: string;
  cpLoss: number | null;
  mateBefore: number | null;
  mateAfter: number | null;
  evalConfidence: "full" | "mate_only" | "degraded" | "degraded_mate_only";
  explanation: string;
  timeSpentSec: number;
  phaseAvgSec: number;
  gamePhase: string;
  patternDescription: string | null;
}

export default function GameReplay({
  gameId,
  moves,
  flags,
  evalPoints,
  playerColor,
  maiaRating,
  humanRating,
  opponentUsername,
  effectiveRatingFires,
  initialPly = 0,
  autoStartSpar = false,
  initialFen,
  pgn,
  showSparControls = true,
}: {
  gameId: string;
  moves: string[];
  flags: ReplayFlag[];
  evalPoints: EvalPoint[];
  playerColor: "white" | "black";
  maiaRating: number | null;
  humanRating: number | null;
  opponentUsername: string;
  effectiveRatingFires: boolean;
  initialPly?: number;
  autoStartSpar?: boolean;
  initialFen?: string;
  pgn?: string;
  showSparControls?: boolean;
}) {
  const replayMoves = useMemo(() => {
    if (!pgn) return moves;
    try {
      const chess = new Chess(initialFen);
      chess.loadPgn(pgn);
      return chess.history();
    } catch {
      return moves;
    }
  }, [initialFen, moves, pgn]);
  const [ply, setPly] = useState(() => Math.max(0, Math.min(replayMoves.length, initialPly)));
  const [activeMode, setActiveMode] = useState<"review" | "compare" | "spar">(autoStartSpar ? "spar" : "review");
  const moveListRef = useRef<HTMLOListElement>(null);
  const highFlagRef = useRef<HTMLElement>(null);
  const highPulsesSeen = useRef(new Set<string>());
  const { fen, invalidPly } = useMemo(() => {
    const chess = new Chess(initialFen);
    let invalid: number | null = null;
    for (let index = 0; index < ply; index++) {
      try {
        chess.move(replayMoves[index]);
      } catch {
        invalid = index;
        break;
      }
    }
    return { fen: chess.fen(), invalidPly: invalid };
  }, [initialFen, replayMoves, ply]);
  const flagsByPly = useMemo(() => new Map(flags.map((flag) => [flag.ply, flag])), [flags]);
  // A selected flag is a decision point: show the position before its move
  // so spar and its resolution marker refer to the same position.
  const currentFlag = flagsByPly.get(ply);
  const flaggedPlies = useMemo(() => [...new Set(flags.map((flag) => flag.ply))].sort((a, b) => a - b), [flags]);
  const scrollFlagPly = currentFlag?.ply ?? flaggedPlies[0];

  useEffect(() => {
    if (scrollFlagPly === undefined || !moveListRef.current) return;
    const list = moveListRef.current;
    const row = list.querySelector<HTMLElement>(`[data-flag-ply="${scrollFlagPly}"]`);
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const targetTop = list.scrollTop + rowRect.top - listRect.top - list.clientHeight * 0.3;
    list.scrollTo({ top: Math.max(0, Math.min(targetTop, list.scrollHeight - list.clientHeight)), behavior: "smooth" });
  }, [scrollFlagPly]);

  function jumpToFirstFlag() {
    if (flaggedPlies.length > 0) setPly(flaggedPlies[0]);
  }

  function jumpToAdjacentFlag(direction: -1 | 1) {
    const currentFlagIndex = flaggedPlies.indexOf(ply);
    if (currentFlagIndex !== -1) {
      const target = flaggedPlies[currentFlagIndex + direction];
      if (target !== undefined) setPly(target);
      return;
    }
    const target = direction === 1
      ? flaggedPlies.find((flagPly) => flagPly >= ply)
      : [...flaggedPlies].reverse().find((flagPly) => flagPly < ply);
    if (target !== undefined) setPly(target);
  }

  const currentFlagIndex = flaggedPlies.indexOf(ply);
  const canGoToPreviousFlag = currentFlagIndex > 0 || (currentFlagIndex === -1 && flaggedPlies.some((flagPly) => flagPly < ply));
  const canGoToNextFlag = (currentFlagIndex >= 0 && currentFlagIndex < flaggedPlies.length - 1) || (currentFlagIndex === -1 && flaggedPlies.some((flagPly) => flagPly >= ply));
  const lastMoveAtPly = lastMove(replayMoves, ply, initialFen);

  useEffect(() => {
    if (currentFlag?.severity !== "high" || !highFlagRef.current) return;
    const positionKey = `${gameId}:${currentFlag.ply}`;
    if (highPulsesSeen.current.has(positionKey)) return;
    highPulsesSeen.current.add(positionKey);
    const pulse = highFlagRef.current.animate(
      [
        { boxShadow: "0 0 0 0 rgba(251,113,133,0)" },
        { boxShadow: "0 0 18px 2px rgba(251,113,133,0.28)" },
        { boxShadow: "0 0 0 0 rgba(251,113,133,0)" },
      ],
      { duration: 900, iterations: 1 },
    );
    return () => pulse.cancel();
  }, [gameId, currentFlag?.ply, currentFlag?.severity]);

  return (
    <div className="grid gap-5 lg:h-[calc(100vh-12rem)] lg:min-h-[600px] lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] lg:overflow-hidden">
      <section className="flex min-h-0 flex-col gap-4">
        {activeMode === "review" && <>
          <div className="mx-auto w-full max-w-[560px] rounded-xl border border-white/10 bg-black/35 p-2">
            <ChessgroundBoard fen={fen} orientation={playerColor} lastMove={lastMoveAtPly} />
          </div>
          <div className="mx-auto flex w-full max-w-[560px] items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3 py-2">
          <button type="button" onClick={() => setPly(0)} disabled={ply === 0} className="rounded px-2 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Go to start">|‹</button>
          <button type="button" onClick={() => setPly((value) => Math.max(0, value - 1))} disabled={ply === 0} className="rounded px-3 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Previous move">←</button>
          <span className="font-mono text-xs tabular-nums text-neutral-400">{ply} / {replayMoves.length} ply</span>
          <button type="button" onClick={() => setPly((value) => Math.min(replayMoves.length, value + 1))} disabled={ply >= replayMoves.length} className="rounded px-3 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Next move">→</button>
          <button type="button" onClick={() => setPly(replayMoves.length)} disabled={ply >= replayMoves.length} className="rounded px-2 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Go to end">›|</button>
          </div>
          {invalidPly !== null && <p role="status" className="text-xs text-amber-200">The saved move list is invalid at ply {invalidPly + 1}; replay stops before that move.</p>}
        </>}
        {activeMode === "compare" && <ComparePanel
          key={`${gameId}:${ply}`}
          fen={fen}
          playedSan={replayMoves[ply] ?? null}
          playerColor={playerColor}
          maiaRating={maiaRating}
          humanRating={humanRating}
          cpLoss={currentFlag?.cpLoss ?? null}
        />}
        {activeMode === "spar" && <PositionSpar
          key={`${gameId}:${currentFlag?.ply ?? ply}:spar`}
          fen={fen}
          humanColor={playerColor}
          maiaRating={maiaRating}
          humanRating={humanRating}
          opponentUsername={opponentUsername}
          effectiveRatingFires={effectiveRatingFires}
          resolution={currentFlag ? { gameId, ply: currentFlag.ply } : null}
          autoStart
          prewarmMaia={showSparControls}
          prewarmMimic={showSparControls}
          showControls={showSparControls}
          inlineSpar
          onOpenChange={(open) => { if (!open) setActiveMode("review"); }}
          viewLastMove={lastMoveAtPly}
        />}
      </section>

      <div className="min-h-0 space-y-4 lg:overflow-y-auto lg:pr-2">
        <nav className="sticky top-0 z-20 flex gap-1 rounded-lg border border-white/10 bg-[#10100f]/95 p-1 backdrop-blur" aria-label="Review mode">
          {(["review", "compare", "spar"] as const).map((mode) => <button key={mode} type="button" aria-pressed={activeMode === mode} onClick={() => setActiveMode(mode)} className={`flex-1 rounded px-3 py-2 text-xs capitalize transition ${activeMode === mode ? "bg-amber-300/15 text-amber-100" : "text-neutral-400 hover:text-white"}`}>{mode === "spar" ? "Spar" : mode}</button>)}
        </nav>
        <EvalBar evalPoints={evalPoints} ply={ply} playerColor={playerColor} />
        {activeMode === "review" && <EvalTimeline moves={replayMoves} flags={flags} evalPoints={evalPoints} selectedPly={ply} onJump={setPly} />}
        {activeMode === "review" && <section className="rounded-xl border border-white/10 bg-black/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-widest text-neutral-500">Move list</p><p className="mt-1 text-xs text-neutral-400">Flagged moves open before the decision so you can play that position.</p></div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => jumpToAdjacentFlag(-1)} disabled={!canGoToPreviousFlag} aria-label="Previous flagged position" title="Previous flagged position" className="rounded border border-white/10 px-2 py-1 text-xs text-neutral-300 hover:bg-white/10 disabled:text-neutral-700">←</button>
              <button type="button" onClick={jumpToFirstFlag} disabled={flaggedPlies.length === 0} className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-neutral-400 hover:border-amber-200/40 hover:text-amber-100 disabled:cursor-default">{flags.length} flags</button>
              <button type="button" onClick={() => jumpToAdjacentFlag(1)} disabled={!canGoToNextFlag} aria-label="Next flagged position" title="Next flagged position" className="rounded border border-white/10 px-2 py-1 text-xs text-neutral-300 hover:bg-white/10 disabled:text-neutral-700">→</button>
            </div>
          </div>
          {replayMoves.length === 0 ? <p className="mt-5 text-sm text-neutral-500">No saved moves for this game.</p> : <ol ref={moveListRef} className="mt-4 grid max-h-[420px] grid-cols-2 content-start gap-1 overflow-y-auto sm:grid-cols-3">
            {replayMoves.map((san, index) => {
              const flag = flagsByPly.get(index);
              const active = flag ? ply === index : ply === index + 1;
              const isWhite = index % 2 === 0;
              return <li key={`${index}-${san}`} data-flag-ply={flag ? index : undefined} className={`flex min-w-0 items-center rounded px-1 ${active ? "bg-emerald-300/15" : "hover:bg-white/5"}`}>
                {isWhite && <span className="shrink-0 pr-1 text-[10px] text-neutral-600">{Math.floor(index / 2) + 1}.</span>}
                <button type="button" onClick={() => setPly(flag ? index : index + 1)} className="min-w-0 flex-1 truncate py-1.5 text-left text-xs text-neutral-200" aria-current={active ? "step" : undefined} title={flag ? `Review ${Math.floor(index / 2) + 1}${isWhite ? ". White" : "... Black"} ${san} from before the decision` : `Go to ${Math.floor(index / 2) + 1}${isWhite ? ". White" : "... Black"} ${san}`}>
                  {san}{flag && <span className={`ml-1.5 inline-block size-1.5 rounded-full align-middle ${severityDot(flag.severity)}`} aria-label={`${flag.severity} flag`} title={`${flag.severity} flag`} />}
                </button>
              </li>;
            })}
          </ol>}
        </section>}

        {currentFlag ? <section ref={highFlagRef} className={`rounded-xl border p-4 ${currentFlag.severity === "high" ? "border-rose-300/20 bg-rose-300/[0.04]" : currentFlag.severity === "medium" ? "border-amber-200/15 bg-amber-200/[0.04]" : "border-sky-200/15 bg-sky-200/[0.03]"}`}>
          <p className={`text-[10px] uppercase tracking-widest ${currentFlag.severity === "high" ? "text-rose-200/80" : currentFlag.severity === "medium" ? "text-amber-100/70" : "text-sky-100/70"}`}>Flagged move · {currentFlag.severity}</p>
          <h2 className="mt-2 text-lg font-semibold">Move {Math.floor(currentFlag.ply / 2) + 1}: {currentFlag.san}</h2>
          <p className={`mt-1 text-xs capitalize ${currentFlag.severity === "high" ? "text-rose-100" : currentFlag.severity === "medium" ? "text-amber-100" : "text-sky-100"}`}>{currentFlag.severity} · {currentFlag.cpLoss === null ? "forced-mate evaluation" : `−${(currentFlag.cpLoss / 100).toFixed(1)} eval swing`}{currentFlag.evalConfidence === "degraded" || currentFlag.evalConfidence === "degraded_mate_only" ? " · lower-depth estimate; review with caution" : ""}</p>
          <p className="mt-2 text-xs leading-5 text-neutral-400">{currentFlag.explanation}</p>
          {currentFlag.timeSpentSec > 0 && currentFlag.phaseAvgSec > 0 && <LiveGameContext phase={currentFlag.gamePhase} timeSpentSec={currentFlag.timeSpentSec} phaseAvgSec={currentFlag.phaseAvgSec} opponentUsername={opponentUsername} />}
          {currentFlag.patternDescription && <p className="mt-2 text-xs leading-5 text-neutral-300">This matches a recurring weakness: <strong>{currentFlag.patternDescription}</strong>.</p>}
          {activeMode === "review" && <button type="button" onClick={() => setActiveMode("compare")} className="mt-4 inline-flex rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-2.5 text-xs font-medium text-amber-100 hover:bg-amber-300/15">Compare moves →</button>}
        </section> : <section className="rounded-xl border border-white/10 p-4 text-xs text-neutral-500">{ply === 0 ? "Starting position" : "No stored flag for this move."}</section>}
        <p className="text-[10px] leading-5 text-neutral-600">This replay uses your saved game record and analysis. It does not fetch the game from Lichess.</p>
      </div>
    </div>
  );
}

function EvalTimeline({ moves, flags, evalPoints, selectedPly, onJump }: {
  moves: string[];
  flags: ReplayFlag[];
  evalPoints: EvalPoint[];
  selectedPly: number;
  onJump: (ply: number) => void;
}) {
  const plotted = evalPoints.flatMap((point) => {
    if (point.ply < 0 || point.ply >= moves.length || point.cpAfter === null) return [];
    const moverSign = point.ply % 2 === 0 ? 1 : -1;
    const whiteCp = point.cpAfter * moverSign;
    const x = moves.length <= 1 ? 0 : point.ply / (moves.length - 1) * 1000;
    const y = 50 - Math.max(-600, Math.min(600, whiteCp)) / 600 * 38;
    return [{ ply: point.ply, x, y }];
  });
  const points = plotted.map(({ x, y }) => `${x},${y}`).join(" ");
  const severityRank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const flagsByPly = new Map<number, ReplayFlag>();
  for (const flag of flags) {
    const previous = flagsByPly.get(flag.ply);
    if (!previous || (severityRank[flag.severity] ?? 0) > (severityRank[previous.severity] ?? 0)) {
      flagsByPly.set(flag.ply, flag);
    }
  }
  const uniqueFlags = [...flagsByPly.values()].sort((a, b) => a.ply - b.ply);

  return <section className="rounded-xl border border-white/10 bg-black/35 p-3" aria-label="Game evaluation timeline">
    <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-neutral-500">
      <span>White advantage</span><span>{evalPoints.length ? `${plotted.length} eval points` : "Evaluation unavailable"}</span>
    </div>
    <div className="relative h-14 overflow-hidden rounded-md border border-white/[0.06] bg-black/30">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <line x1="0" y1="50" x2="1000" y2="50" stroke="rgba(255,255,255,.12)" strokeDasharray="4 8" />
        {points && <polyline points={points} fill="none" stroke="#d4d4d8" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
      </svg>
      {uniqueFlags.map((flag) => <button key={`${flag.ply}-${flag.flagType}`} type="button" onClick={() => onJump(flag.ply)}
        aria-label={`Jump to move ${Math.floor(flag.ply / 2) + 1}, ${flag.san}, ${flag.severity} flag`}
        title={`Move ${Math.floor(flag.ply / 2) + 1} · ${flag.san} · ${flag.severity}`}
        className={`absolute inset-y-0 z-10 w-1 -translate-x-1/2 ${flag.severity === "high" ? "bg-rose-400" : flag.severity === "medium" ? "bg-amber-300" : "bg-neutral-400"} ${selectedPly === flag.ply ? "w-1.5 shadow-[0_0_8px_rgba(251,191,36,.8)]" : "opacity-80 hover:opacity-100"}`}
        style={{ left: `${moves.length <= 1 ? 0 : flag.ply / (moves.length - 1) * 100}%` }} />)}
      {selectedPly < moves.length && <span aria-hidden="true" className="absolute inset-y-0 z-[5] w-px bg-white/70" style={{ left: `${moves.length <= 1 ? 0 : selectedPly / (moves.length - 1) * 100}%` }} />}
    </div>
    <div className="mt-1 flex justify-between text-[9px] text-neutral-600"><span>Start</span><span>End</span></div>
  </section>;
}

function EvalBar({ evalPoints, ply, playerColor }: {
  evalPoints: EvalPoint[];
  ply: number;
  playerColor: "white" | "black";
}) {
  const point = evalPoints.find((entry) => entry.ply === ply);
  const moverColor = ply % 2 === 0 ? "white" : "black";
  const sign = moverColor === playerColor ? 1 : -1;
  const cp = point?.cpAfter === null || point?.cpAfter === undefined
    ? point?.mateAfter === null || point?.mateAfter === undefined ? null : point.mateAfter > 0 ? 1000 * sign : -1000 * sign
    : point.cpAfter * sign;
  const marker = cp === null ? 50 : Math.max(0, Math.min(100, (Math.max(-1000, Math.min(1000, cp)) + 1000) / 20));
  return <section aria-label="Evaluation bar from your perspective" className="rounded-lg border border-white/10 bg-black/30 p-3">
    <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-neutral-500">
      <span>Worse for you</span>
      <span>{cp === null ? "Evaluation unavailable" : `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)} pawns for you`}</span>
      <span>Better for you</span>
    </div>
    <div className="relative mt-2 h-2 rounded-full bg-gradient-to-r from-rose-900 via-neutral-700 to-emerald-800">
      <span className="absolute -top-1 h-4 w-0.5 bg-white shadow" style={{ left: `${marker}%` }} />
    </div>
  </section>;
}

function lastMove(moves: string[], ply: number, initialFen?: string): [Key, Key] | undefined {
  if (ply === 0) return undefined;
  const chess = new Chess(initialFen);
  try {
    for (let index = 0; index < ply; index++) chess.move(moves[index]);
    const history = chess.history({ verbose: true });
    const move = history[history.length - 1];
    return move ? [move.from, move.to] : undefined;
  } catch {
    return undefined;
  }
}

function severityDot(severity: string) {
  if (severity === "high") return "bg-rose-400";
  if (severity === "medium") return "bg-amber-300";
  return "bg-sky-300";
}
