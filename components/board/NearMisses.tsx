"use client";

import { useState } from "react";
import Link from "next/link";
import type { NearMissItem } from "@/lib/ghost/getNearMisses";

export default function NearMisses({ items }: { items: NearMissItem[] }) {
  const [mode, setMode] = useState<"flipped" | "chance">("flipped");
  const visible = items.filter((item) => item.mode === mode);
  return <section className="mt-8 border-t border-white/10 pt-6">
    <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Streak Ghosts</p>
    <h2 className="mt-2 text-lg font-medium text-neutral-100">Close calls in your saved games</h2>
    <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500">A retrospective scan of evaluated losses and draws. These lines show positions from the saved engine analysis; they do not prove the outcome would have changed.</p>
    <div className="mt-4 inline-flex rounded-lg border border-white/10 p-1" role="group" aria-label="Near miss filter">
      <button type="button" aria-pressed={mode === "flipped"} onClick={() => setMode("flipped")} className={`rounded-md px-3 py-1.5 text-xs ${mode === "flipped" ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-200"}`}>Winning edge dropped</button>
      <button type="button" aria-pressed={mode === "chance"} onClick={() => setMode("chance")} className={`rounded-md px-3 py-1.5 text-xs ${mode === "chance" ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-200"}`}>Had a +1.0 pawn chance</button>
    </div>
    {visible.length ? <ul className="mt-3 divide-y divide-white/10">
      {visible.slice(0, 8).map((item) => <li key={`${item.gameId}:${item.ply}:${item.mode}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
        <span className="font-mono text-sm text-neutral-100">{item.san}</span>
        <span className="text-xs text-neutral-400">vs. {item.opponentUsername} · {item.result} · {item.openingName ?? "opening unknown"}</span>
        <span className="ml-auto text-xs tabular-nums text-emerald-200">{item.mode === "flipped" ? `${(item.cp / 100).toFixed(1)} pawn swing` : `+${(item.cp / 100).toFixed(1)} pawns`}</span>
        <Link href={`/dashboard/games/${encodeURIComponent(item.gameId)}?ply=${item.ply}`} className="w-full text-xs text-emerald-300 hover:text-emerald-200">Review position →</Link>
      </li>)}
    </ul> : <p className="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-4 text-xs text-neutral-500">No matching evaluated losses or draws found in the recent saved games.</p>}
  </section>;
}
