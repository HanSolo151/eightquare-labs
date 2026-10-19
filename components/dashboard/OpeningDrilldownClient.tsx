"use client";

import { useState } from "react";
import PositionSpar from "@/components/board/PositionSpar";
import type { DrilldownNode } from "@/lib/openings/getOpeningDrilldown";

export function OpeningDrilldownClient({ nodes, initialNode }: { nodes: DrilldownNode[]; initialNode: DrilldownNode | null }) {
  const [selected, setSelected] = useState(initialNode);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
      <section className="rounded-xl border border-white/10 bg-black/35 p-5">
        <p className="text-xs uppercase tracking-widest text-neutral-500">Your moves in this opening</p>
        <p className="mt-2 text-xs text-neutral-500">Select a move to start a spar from the position just before it.</p>
        {nodes.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No player moves found in the first 14 plies.</p> : (
          <ol className="mt-4 space-y-2">
            {nodes.map((node) => {
              const active = selected?.fenBefore === node.fenBefore && selected.san === node.san;
              return <li key={`${node.ply}-${node.fenBefore}-${node.san}`} style={{ paddingLeft: `${(node.ply % 16) * 0.5}rem` }}>
                <button type="button" onClick={() => setSelected(node)} aria-pressed={active} className={`flex w-full flex-wrap items-center gap-3 rounded px-2 py-2 text-left text-sm ${active ? "bg-emerald-300/10 text-white" : "text-neutral-300 hover:bg-white/[0.04]"}`}>
                  <span className="font-mono">{Math.floor(node.ply / 2) + 1}{node.ply % 2 ? "…" : "."} {node.san}</span>
                  <span className="text-xs text-neutral-500">{node.occurrences}×</span>
                  {node.flaggedCount > 0 && <span className="rounded border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 text-[10px] text-rose-200">{node.flaggedCount} flagged · {Math.round(node.avgCpLoss ?? 0)} cp avg</span>}
                </button>
              </li>;
            })}
          </ol>
        )}
      </section>
      {selected ? <section className="rounded-xl border border-white/10 bg-black/35 p-4 sm:p-5">
        <p className="mb-3 text-xs uppercase tracking-widest text-neutral-500">Spar from before {selected.san}</p>
        <PositionSpar fen={selected.fenBefore} humanColor={selected.playerColor} maiaRating={selected.maiaRating} humanRating={selected.humanRating} opponentUsername={selected.opponentUsername} />
      </section> : <p className="rounded-xl border border-dashed border-white/10 p-5 text-sm text-neutral-500">No replayable positions in this opening.</p>}
    </div>
  );
}
