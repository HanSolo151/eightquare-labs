import type { PatternProgressDelta } from "@/lib/dashboard/getSignatureSignals";

const TREND_STYLE = {
  improving: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  steady: "border-white/10 bg-white/[0.03] text-neutral-300",
  worsening: "border-amber-300/25 bg-amber-300/10 text-amber-200",
} as const;

const TREND_LABEL = { improving: "↓ Improving", steady: "→ Steady", worsening: "↑ Worsening" } as const;

export default function PatternProgress({ items }: { items: PatternProgressDelta[] }) {
  return <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
    <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">After spar practice</p>
    <h2 className="mt-2 text-lg font-medium">Pattern progress</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">Average flagged centipawn loss before and after you first drilled a matching position. At least three recorded occurrences on each side are required; changes under 25 cp are labeled steady.</p>
    {items.length ? <ul className="mt-4 divide-y divide-white/10">
      {items.map((item) => <li key={item.patternId} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
        <span className="min-w-0 flex-1 text-sm text-neutral-200">{item.description}</span>
        <span className={`rounded-full border px-2.5 py-1 text-xs ${TREND_STYLE[item.trend]}`}>{TREND_LABEL[item.trend]}</span>
        <span className="w-full text-xs text-neutral-500 sm:w-auto">{item.beforeAvgCp} → {item.afterAvgCp} cp avg · {item.beforeCount}/{item.afterCount} moves</span>
      </li>)}
    </ul> : <p className="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-4 text-xs leading-5 text-neutral-500">No trend has enough data yet. Drill a flagged position, then build at least three matching flagged occurrences before and after it.</p>}
  </section>;
}
