"use client";

import { useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import PositionSpar from "./PositionSpar";

interface ReplayFlag {
  ply: number;
  san: string;
  severity: string;
  flagType: string;
  cpLoss: number;
  explanation: string;
}

export default function GameReplay({
  gameId,
  moves,
  flags,
  playerColor,
  maiaRating,
  humanRating,
  opponentUsername,
  effectiveRatingFires,
  initialPly = 0,
}: {
  gameId: string;
  moves: string[];
  flags: ReplayFlag[];
  playerColor: "white" | "black";
  maiaRating: number | null;
  humanRating: number | null;
  opponentUsername: string;
  effectiveRatingFires: boolean;
  initialPly?: number;
}) {
  const [ply, setPly] = useState(() => Math.max(0, Math.min(moves.length, initialPly)));
  const { fen, invalidPly } = useMemo(() => {
    const chess = new Chess();
    let invalid: number | null = null;
    for (let index = 0; index < ply; index++) {
      try {
        chess.move(moves[index]);
      } catch {
        invalid = index;
        break;
      }
    }
    return { fen: chess.fen(), invalidPly: invalid };
  }, [moves, ply]);
  const flagsByPly = useMemo(() => new Map(flags.map((flag) => [flag.ply, flag])), [flags]);
  const currentFlag = flagsByPly.get(ply - 1);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,480px)_minmax(280px,1fr)]">
      <section className="space-y-4">
        <PositionSpar
          key={`${gameId}:${currentFlag?.ply ?? "none"}`}
          fen={fen}
          humanColor={playerColor}
          maiaRating={maiaRating}
          humanRating={humanRating}
          opponentUsername={opponentUsername}
          effectiveRatingFires={effectiveRatingFires}
          resolution={currentFlag ? { gameId, ply: currentFlag.ply } : null}
          viewLastMove={lastMove(moves, ply)}
        />
        <div className="mx-auto flex w-full max-w-[480px] items-center justify-between rounded-lg border border-white/10 bg-black/35 px-3 py-2">
          <button type="button" onClick={() => setPly(0)} disabled={ply === 0} className="rounded px-2 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Go to start">|‹</button>
          <button type="button" onClick={() => setPly((value) => Math.max(0, value - 1))} disabled={ply === 0} className="rounded px-3 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Previous move">←</button>
          <span className="font-mono text-xs tabular-nums text-neutral-400">{ply} / {moves.length} ply</span>
          <button type="button" onClick={() => setPly((value) => Math.min(moves.length, value + 1))} disabled={ply >= moves.length} className="rounded px-3 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Next move">→</button>
          <button type="button" onClick={() => setPly(moves.length)} disabled={ply >= moves.length} className="rounded px-2 py-1 text-sm text-neutral-300 hover:bg-white/10 disabled:text-neutral-700" aria-label="Go to end">›|</button>
        </div>
        {invalidPly !== null && <p role="status" className="text-xs text-amber-200">The saved move list is invalid at ply {invalidPly + 1}; replay stops before that move.</p>}
      </section>

      <div className="space-y-4">
        <section className="rounded-xl border border-white/10 bg-black/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-widest text-neutral-500">Move list</p><p className="mt-1 text-xs text-neutral-400">Select a move to jump to that position.</p></div>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-neutral-400">{flags.length} flags</span>
          </div>
          {moves.length === 0 ? <p className="mt-5 text-sm text-neutral-500">No saved moves for this game.</p> : <ol className="mt-4 grid max-h-[420px] grid-cols-2 content-start gap-1 overflow-y-auto sm:grid-cols-3">
            {moves.map((san, index) => {
              const flag = flagsByPly.get(index);
              const active = ply === index + 1;
              const isWhite = index % 2 === 0;
              return <li key={`${index}-${san}`} className={`flex min-w-0 items-center rounded px-1 ${active ? "bg-emerald-300/15" : "hover:bg-white/5"}`}>
                {isWhite && <span className="shrink-0 pr-1 text-[10px] text-neutral-600">{Math.floor(index / 2) + 1}.</span>}
                <button type="button" onClick={() => setPly(index + 1)} className="min-w-0 flex-1 truncate py-1.5 text-left text-xs text-neutral-200" aria-current={active ? "step" : undefined} title={`Go to ${Math.floor(index / 2) + 1}${isWhite ? ". White" : "... Black"} ${san}`}>
                  {san}{flag && <span className={`ml-1.5 inline-block size-1.5 rounded-full align-middle ${severityDot(flag.severity)}`} aria-label={`${flag.severity} flag`} title={`${flag.severity} flag`} />}
                </button>
              </li>;
            })}
          </ol>}
        </section>

        {currentFlag ? <section className="rounded-xl border border-amber-200/15 bg-amber-200/[0.04] p-4">
          <p className="text-[10px] uppercase tracking-widest text-amber-100/70">Flagged move · {currentFlag.severity}</p>
          <h2 className="mt-2 text-sm">{currentFlag.san} <span className="font-normal text-neutral-400">· {currentFlag.flagType.replaceAll("_", " ")}</span></h2>
          <p className="mt-2 text-xs leading-5 text-neutral-400">{currentFlag.explanation}</p>
          <p className="mt-3 font-mono text-xs text-neutral-300">{Math.round(currentFlag.cpLoss)} cp loss</p>
        </section> : <section className="rounded-xl border border-white/10 p-4 text-xs text-neutral-500">{ply === 0 ? "Starting position" : "No stored flag for this move."}</section>}
        <p className="text-[10px] leading-5 text-neutral-600">This replay uses your saved game record and analysis. It does not fetch the game from Lichess.</p>
      </div>
    </div>
  );
}

function lastMove(moves: string[], ply: number): [Key, Key] | undefined {
  if (ply === 0) return undefined;
  const chess = new Chess();
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
