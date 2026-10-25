"use client";

import Link from "next/link";
import { useState } from "react";
import type { BiasData, HeatmapTheme, SquareView } from "@/lib/bias/getBiasData";

const THEMES: { id: HeatmapTheme; label: string }[] = [
  { id: "blunderDensity", label: "Blunder density" },
  { id: "timePressure", label: "Time pressure" },
  { id: "accuracy", label: "Accuracy" },
];

const LOW = [23, 23, 23];
const AMBER = [105, 62, 29];
const RED = [173, 32, 43];

function heatColor(value: number): string {
  const intensity = Math.max(0, Math.min(1, value));
  const from = intensity < 0.5 ? LOW : AMBER;
  const to = intensity < 0.5 ? AMBER : RED;
  const progress = intensity < 0.5 ? intensity * 2 : (intensity - 0.5) * 2;
  const rgb = from.map((channel, index) => Math.round(channel + (to[index]! - channel) * progress));
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

function squaresInBoardOrder(squares: SquareView[]) {
  const byName = new Map(squares.map((square) => [square.square, square]));
  return Array.from({ length: 64 }, (_, index) => {
    const file = String.fromCharCode(97 + index % 8);
    const rank = 8 - Math.floor(index / 8);
    return byName.get(`${file}${rank}`)!;
  });
}

function gamesHref(square: SquareView) {
  if (!square.flaggedPositions.length) return null;
  const positions = square.flaggedPositions.slice(0, 50);
  const params = new URLSearchParams({
    gameIds: [...new Set(positions.map((position) => position.gameId))].join(","),
    occurrences: positions.map((position) => `${position.gameId}:${position.ply}`).join(","),
    occurrenceCount: String(square.flaggedCount),
  });
  return `/dashboard/games?${params.toString()}`;
}

function focusForTheme(theme: HeatmapTheme, squares: SquareView[]) {
  if (theme === "blunderDensity") {
    const totalFlags = squares.reduce((sum, square) => sum + square.flaggedCount, 0);
    const square = [...squares].sort((a, b) => b.flaggedCount - a.flaggedCount)[0];
    return square?.flaggedCount ? {
      label: "Nemesis square",
      square,
      detail: `${Math.round(square.flaggedCount / totalFlags * 100)}% of flagged moves · ${square.flaggedCount} of ${totalFlags}`,
    } : null;
  }
  if (theme === "timePressure") {
    const totalUnder30 = squares.reduce((sum, square) => sum + square.under30Count, 0);
    const square = [...squares].sort((a, b) => b.under30Count - a.under30Count)[0];
    return square?.under30Count ? {
      label: "Most under pressure",
      square,
      detail: `${square.under30Count} of ${totalUnder30} moves made with under 30 seconds` ,
    } : null;
  }
  const eligible = squares.filter((square) => square.moveCount >= 5);
  const square = [...eligible].sort((a, b) => (1 - a.flaggedCount / a.moveCount) - (1 - b.flaggedCount / b.moveCount))[0];
  return square ? {
    label: "Most error-prone",
    square,
    detail: `${Math.round(square.flaggedCount / square.moveCount * 100)}% flagged · ${square.flaggedCount} of ${square.moveCount} moves`,
  } : null;
}

function GhostBoard() {
  const squares = Array.from({ length: 64 }, (_, index) => {
    const file = String.fromCharCode(97 + index % 8);
    const rank = 8 - Math.floor(index / 8);
    return `${file}${rank}`;
  });
  return <div aria-hidden="true" className="mx-auto grid aspect-square w-full max-w-[400px] grid-cols-8 overflow-hidden rounded-lg border border-white/10 opacity-30">
    {squares.map((square) => <div key={square} className="flex items-end justify-end border border-white/[0.07] bg-transparent p-1 font-mono text-[9px] text-white/45">{square}</div>)}
  </div>;
}

function SquareDetails({ square, flagOnly }: { square: SquareView; flagOnly: boolean }) {
  return <div>
    <p className="font-mono text-xs text-neutral-300">{square.square} <span className="font-sans text-neutral-500">· {flagOnly ? `${square.flaggedCount} flagged moves` : `${square.flaggedCount} flagged / ${square.moveCount} total moves`}</span></p>
    {square.clockDataCount > 0 && <p className="mt-1 text-xs text-neutral-400">{square.under30Count} under 30 sec / {square.clockDataCount} clocked moves</p>}
    {square.avgCpLoss !== null && <p className="mt-1 text-xs text-neutral-400">Average loss {Math.round(square.avgCpLoss)} cp</p>}
    {square.topFlagTypes.length > 0 && <p className="mt-1 text-xs text-neutral-500">Mostly {square.topFlagTypes.join(", ")}</p>}
    {gamesHref(square) && <Link href={gamesHref(square)!} className="mt-3 inline-flex text-xs text-emerald-200 hover:text-white">Review these {square.flaggedCount} flagged {square.flaggedCount === 1 ? "move" : "moves"} →</Link>}
  </div>;
}

export default function BlindSpotHeatmap({ data }: { data: BiasData }) {
  const [theme, setTheme] = useState<HeatmapTheme>("blunderDensity");
  const [hovered, setHovered] = useState<SquareView | null>(null);
  const visibleThemes = THEMES.filter((item) => (data.availableThemes ?? THEMES.map((entry) => entry.id)).includes(item.id));
  const activeTheme = visibleThemes.some((item) => item.id === theme) ? theme : visibleThemes[0]?.id ?? "blunderDensity";
  const squares = data.squares[activeTheme];
  const orderedSquares = squaresInBoardOrder(squares);
  const focus = focusForTheme(activeTheme, squares);
  const selectedSquare = hovered ?? focus?.square ?? squares[0]!;
  const remaining = Math.max(0, 20 - data.sampleSize);

  if (!data.meetsThreshold) {
    return <div className="grid items-center gap-5 rounded-xl border border-white/10 bg-white/[0.015] p-4 sm:grid-cols-[minmax(180px,0.8fr)_1.2fr] sm:p-6">
      <GhostBoard />
      <div className="text-center sm:text-left">
        <p className="text-sm font-medium text-neutral-200">Your heatmap is taking shape</p>
        <p className="mt-2 text-xs leading-5 text-neutral-400">{data.sampleSize} of 20 unique flagged moves are mapped{remaining ? ` · ${remaining} more to unlock` : ""}. Sync games and let their analysis finish to reveal your board patterns.</p>
        <Link href="/dashboard/signature#game-sync" className="mt-4 inline-flex rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3.5 py-2.5 text-xs text-emerald-100 hover:bg-emerald-300/15">Sync games →</Link>
      </div>
    </div>;
  }

  return <div>
    {visibleThemes.length > 1 && <div role="group" aria-label="Heatmap view" className="mb-5 inline-flex gap-1 rounded-lg border border-white/10 bg-black/30 p-1 text-xs">
      {visibleThemes.map((item) => <button key={item.id} type="button" onClick={() => { setTheme(item.id); setHovered(null); }} aria-pressed={activeTheme === item.id}
        className={`rounded px-3 py-2 transition ${activeTheme === item.id ? "bg-white/10 text-white" : "text-neutral-400 hover:text-white"}`}>{item.label}</button>)}
    </div>}

    <div className="grid max-w-5xl items-start gap-6 lg:grid-cols-[minmax(300px,480px)_minmax(240px,1fr)]">
      <div>
        <div className="grid aspect-square w-full grid-cols-8 overflow-hidden rounded-lg border border-white/15 bg-transparent" role="group" aria-label={`${activeTheme} chessboard heatmap`}>
          {orderedSquares.map((square) => {
            const pressureMode = activeTheme === "timePressure";
            const signalCount = pressureMode ? square.under30Count : square.flaggedCount;
            const active = signalCount > 0 && (data.flagOnly || square.moveCount > 0 || pressureMode && square.clockDataCount > 0);
            const colorValue = activeTheme === "accuracy" ? 1 - square.value : square.value;
            const description = activeTheme === "timePressure"
              ? `${square.square}: ${square.under30Count} moves under 30 seconds from ${square.clockDataCount} clocked moves`
              : `${square.square}: ${square.flaggedCount} flagged moves from ${square.moveCount} total moves`;
            const href = gamesHref(square);
            const className = `flex aspect-square items-center justify-center border border-white/[0.07] font-mono text-[9px] text-white/55 focus:z-10 focus:outline focus:outline-2 focus:outline-white ${href ? "cursor-pointer" : "cursor-default"}`;
            const style = { backgroundColor: active ? heatColor(colorValue) : "transparent" };
            const events = {
              onMouseEnter: () => setHovered(square),
              onFocus: () => setHovered(square),
            };
            return <button key={square.square} type="button" {...events} onClick={() => setHovered(square)} style={style} className={className}
              aria-label={`${description}${href ? "; activate to review source games" : ""}`} title={description}>{square.square}</button>;
          })}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[10px] text-neutral-500">
          <span>Low</span><span className="h-2.5 flex-1 rounded-full" style={{ background: "linear-gradient(90deg, rgb(23 23 23), rgb(105 62 29), rgb(173 32 43))" }} /><span>High concentration</span>
        </div>
      </div>

      <aside className="space-y-3">
        <section className="h-[330px] overflow-hidden rounded-xl border border-rose-300/15 bg-rose-300/[0.035] p-4 sm:p-5">
          <p className="text-[10px] uppercase tracking-[0.2em] text-rose-200/70">{focus?.label ?? "Square diagnosis"}</p>
          <p className="mt-1 font-mono text-6xl font-semibold tracking-tight text-rose-100 sm:text-7xl">{selectedSquare.square}</p>
          <p className="mt-2 text-xs leading-5 text-neutral-300">{hovered ? "Selected square" : focus?.detail ?? "No concentrated signal yet."}</p>
          <div className="mt-4 h-[132px] overflow-y-auto border-t border-white/10 pt-3"><SquareDetails square={selectedSquare} flagOnly={data.flagOnly ?? false} /></div>
        </section>

        {!data.flagOnly && <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
          {([ ["Rank", data.axes.ranks[0]], ["File", data.axes.files[0]], ["Diagonal", data.axes.diagonals[0]] ] as const).map(([kind, axis]) => <div key={kind} className="rounded-lg border border-white/10 bg-black/25 p-3">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">Highest flagged rate · {kind}</p>
            {axis ? <p className="mt-1.5 text-sm text-neutral-200">{axis.label} <span className="ml-1 text-xs text-neutral-500">{Math.round(axis.flaggedRate * 100)}% · {axis.flaggedCount}/{axis.moveCount}</span></p> : <p className="mt-1.5 text-xs text-neutral-500">Not enough moves to compare</p>}
          </div>)}
        </div>}
        <p className="px-1 text-[10px] leading-5 text-neutral-600">Red marks a stronger signal in the selected view. Click a marked square to inspect its saved positions. Based on {data.sampleSize} unique flagged player moves.</p>
      </aside>
    </div>
  </div>;
}
