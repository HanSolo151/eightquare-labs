"use client";

import Link from "next/link";
import { useState } from "react";
import BlindSpotHeatmap from "@/components/dashboard/BlindSpotHeatmap";
import { heatmapDrilldownHref, type PatternsHeatmap } from "@/lib/patterns/getPatternsData";
import type { BiasData, HeatmapTheme } from "@/lib/bias/getBiasData";

const TABS: { id: HeatmapTheme | "phaseSeverity"; label: string }[] = [
  { id: "blunderDensity", label: "Blunder density" },
  { id: "timePressure", label: "Time pressure" },
  { id: "accuracy", label: "Accuracy" },
  { id: "phaseSeverity", label: "Phase × severity" },
];
const PHASES = ["opening", "middlegame", "endgame"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;
const PHASE_LABEL: Record<(typeof PHASES)[number], string> = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
};
const SEVERITY_STYLE = {
  high: { text: "text-rose-200", color: "#fb7185" },
  medium: { text: "text-amber-100", color: "#fcd34d" },
  low: { text: "text-sky-100", color: "#7dd3fc" },
} as const;

function PhaseSeverity({ heatmap }: { heatmap: PatternsHeatmap }) {
  const maxFlags = Math.max(1, ...PHASES.flatMap((phase) => SEVERITIES.map((severity) => heatmap[phase][severity])));
  return <section>
    <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Flag distribution</p>
    <h2 className="mt-2 text-lg font-medium">Phase × severity</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">Counts of persisted flags. Select a cell to filter the game archive. These are raw counts, not rates.</p>
    <div className="mt-6 grid grid-cols-[minmax(96px,1fr)_repeat(3,minmax(48px,0.7fr))] gap-2 text-center">
      <div />
      {SEVERITIES.map((severity) => <div key={severity} className={`pb-1 text-[10px] uppercase tracking-wider ${SEVERITY_STYLE[severity].text}`}>{severity}</div>)}
      {PHASES.map((phase) => <div key={phase} className="contents">
        <div className="flex items-center text-left text-xs text-neutral-300">{PHASE_LABEL[phase]}</div>
        {SEVERITIES.map((severity) => {
          const count = heatmap[phase][severity];
          const opacity = count ? 0.18 + (count / maxFlags) * 0.78 : 0.035;
          return <Link key={`${phase}-${severity}`} href={heatmapDrilldownHref(phase, severity)} className="flex aspect-square max-h-20 items-center justify-center rounded-lg border border-white/5 font-mono text-sm tabular-nums text-white hover:border-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" style={{ backgroundColor: `color-mix(in srgb, ${SEVERITY_STYLE[severity].color} ${Math.round(opacity * 100)}%, transparent)` }} aria-label={`${PHASE_LABEL[phase]}, ${severity}: ${count} flags. Filter games`} title={`${PHASE_LABEL[phase]} · ${severity}: ${count}`}>{count}</Link>;
        })}
      </div>)}
    </div>
  </section>;
}

export default function BlindSpotsExplorer({ bias, heatmap }: { bias: BiasData; heatmap: PatternsHeatmap }) {
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>("blunderDensity");
  const activeTheme = activeTab === "phaseSeverity" ? null : activeTab;

  return <div className="space-y-5">
    <div role="tablist" aria-label="Blind spot views" className="flex flex-wrap gap-1 rounded-lg border border-white/10 bg-black/30 p-1 text-xs">
      {TABS.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} className={`rounded px-3 py-2 transition ${activeTab === tab.id ? "bg-white/10 text-white" : "text-neutral-400 hover:text-white"}`}>{tab.label}</button>)}
    </div>
    {activeTheme ? <section role="tabpanel">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Spatial tendencies</p>
      <h2 className="mt-2 text-lg font-medium">{TABS.find((tab) => tab.id === activeTheme)?.label}</h2>
      <p className="mb-5 mt-1 text-xs leading-5 text-neutral-500">Square-level move and flag patterns. Hover or focus a square for its counts and linked games.</p>
      <BlindSpotHeatmap key={activeTheme} data={bias} initialTheme={activeTheme} showThemeControls={false} />
    </section> : <div role="tabpanel"><PhaseSeverity heatmap={heatmap} /></div>}
  </div>;
}
