"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  username: string;
  games: number;
  evaluatedGames: number;
  patternCount: number;
  topOpenings: { name: string; eco: string; count: number }[];
  tempo: { phase: string; seconds: number | null }[];
}

export default function SignatureShareCard(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-300 hover:bg-white/5 hover:text-white">Share Signature</button>
    {open && typeof document !== "undefined" && createPortal(
      <div className="signature-share-overlay fixed inset-0 z-[1200] overflow-y-auto bg-black/85 p-4 sm:p-8" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
        <section className="mx-auto my-4 max-w-2xl rounded-2xl border border-white/15 bg-[#10100f] p-5 text-white shadow-2xl sm:p-8">
          <div className="mb-5 flex justify-end gap-2 signature-share-controls">
            <button type="button" onClick={() => window.print()} className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-300/15">Print / save PDF</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-300 hover:bg-white/5">Close</button>
          </div>
          <article className="signature-share-card">
            <p className="text-[10px] uppercase tracking-[0.28em] text-emerald-300">EightSquare · Chess DNA</p>
            <h2 className="mt-3 text-3xl font-semibold">{props.username}&apos;s Signature</h2>
            <p className="mt-2 text-sm text-neutral-400">Built from {props.evaluatedGames} evaluated games in a {props.games}-game archive.</p>
            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs text-neutral-500">Recurring patterns</p><p className="mt-2 text-3xl font-semibold">{props.patternCount}</p></div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs text-neutral-500">Most played opening</p><p className="mt-2 text-lg font-medium">{props.topOpenings[0]?.name ?? "Not enough data yet"}</p><p className="mt-1 text-xs text-neutral-500">{props.topOpenings[0] ? `${props.topOpenings[0].eco} · ${props.topOpenings[0].count} games` : "Sync more games to build your repertoire"}</p></div>
            </div>
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-neutral-500">Typical time per move</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {props.tempo.map((item) => <div key={item.phase}><p className="text-[10px] capitalize text-neutral-500">{item.phase}</p><p className="mt-1 text-sm tabular-nums">{item.seconds === null ? "—" : `${item.seconds.toFixed(1)}s`}</p></div>)}
              </div>
            </div>
            <p className="mt-6 border-t border-white/10 pt-4 text-[10px] text-neutral-500">A snapshot of your saved Signature data. It changes as more games are evaluated.</p>
          </article>
        </section>
      </div>,
      document.body,
    )}
  </>;
}
