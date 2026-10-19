"use client";

import { useState } from "react";
import type { BiasData, HeatmapTheme, SquareView } from "@/lib/bias/getBiasData";

const THEMES: { id: HeatmapTheme; label: string }[] = [
  { id: "blunderDensity", label: "Blunder rate" },
  { id: "timePressure", label: "Time pressure" },
  { id: "accuracy", label: "Unflagged rate" },
];

function heatColor(value: number): string {
  const hue = 220 - value * 220;
  return `hsl(${hue} 70% ${35 + value * 10}%)`;
}

export default function BlindSpotHeatmap({ data }: { data: BiasData }) {
  const [theme, setTheme] = useState<HeatmapTheme>("blunderDensity");
  const [hovered, setHovered] = useState<SquareView | null>(null);

  if (!data.meetsThreshold) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-xs leading-5 text-neutral-500">
        {data.sampleSize} of 20 unique flagged moves recorded. More data is needed before showing this heatmap.
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-1 rounded-lg border border-white/10 bg-black/30 p-1 text-xs">
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTheme(item.id)}
            aria-pressed={theme === item.id}
            className={`flex-1 rounded px-2 py-1.5 ${theme === item.id ? "bg-amber-500/20 text-amber-200" : "text-neutral-400 hover:text-white"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-[10px] text-neutral-500">
        Color compares each square with your overall rate; squares with fewer than five moves stay neutral.
      </p>
      <div className="mt-3 grid aspect-square max-w-[480px] grid-cols-8 overflow-hidden rounded-lg border border-white/10">
        {data.squares[theme].map((square) => {
          const enoughMoves = square.moveCount >= 5;
          const colorValue = theme === "accuracy" ? 1 - square.value : square.value;
          const description = `${square.square}: ${square.flaggedCount} flagged moves from ${square.moveCount} moves${square.clockDataCount ? `; ${square.clockDataCount} with clock data` : ""}`;
          return (
            <button
              key={square.square}
              type="button"
              onMouseEnter={() => setHovered(square)}
              onFocus={() => setHovered(square)}
              onMouseLeave={() => setHovered(null)}
              onBlur={() => setHovered(null)}
              style={{ backgroundColor: enoughMoves ? heatColor(colorValue) : "#262626" }}
              className="aspect-square text-[9px] text-black/50 focus:z-10 focus:outline focus:outline-2 focus:outline-white"
              aria-label={description}
              title={description}
            >
              {square.square}
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
        {([
          ["Ranks", data.axes.ranks[0]],
          ["Files", data.axes.files[0]],
          ["Diagonals", data.axes.diagonals[0]],
        ] as const).map(([kind, axis]) => (
          <div key={kind} className="rounded-lg border border-white/10 bg-black/25 p-3">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">Highest flagged rate · {kind}</p>
            {axis ? (
              <p className="mt-2 text-neutral-200">{axis.label} · {Math.round(axis.flaggedRate * 100)}% <span className="text-neutral-500">({axis.flaggedCount}/{axis.moveCount})</span></p>
            ) : <p className="mt-2 text-neutral-500">Not enough moves to compare</p>}
          </div>
        ))}
      </div>

      <div className="mt-3 min-h-[2.5rem] text-xs text-neutral-400" aria-live="polite">
        {hovered ? (
          <p>
            <span className="font-mono text-white">{hovered.square}</span> — {hovered.flaggedCount} flagged / {hovered.moveCount} moves
            {hovered.avgCpLoss !== null && <> · average {Math.round(hovered.avgCpLoss)} cp loss</>}
            {hovered.topFlagTypes.length > 0 && <> · {hovered.topFlagTypes.join(", ")}</>}
          </p>
        ) : data.caption ? <p>{data.caption}</p> : null}
      </div>
    </div>
  );
}
