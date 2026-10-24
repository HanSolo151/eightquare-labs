import Link from "next/link";
import type { PatternProgressDelta } from "@/lib/dashboard/getSignatureSignals";

const TREND_STYLE = {
  improving: "text-emerald-200",
  steady: "text-neutral-300",
  worsening: "text-amber-200",
  baseline: "text-sky-200",
  untrained: "text-amber-100",
} as const;

function phaseLabel(phase: PatternProgressDelta["phase"]) {
  return phase === "middlegame" ? "Middlegame" : phase === "endgame" ? "Endgame" : "Opening";
}

function evidenceHref(item: PatternProgressDelta) {
  const evidence = item.evidence.slice(0, 50);
  const params = new URLSearchParams({
    gameIds: [...new Set(evidence.map((entry) => entry.gameId))].join(","),
    occurrences: evidence.map((entry) => `${entry.gameId}:${entry.ply}`).join(","),
    occurrenceCount: String(item.evidence.length),
  });
  return `/dashboard/games?${params.toString()}`;
}

function replayHref(entry: PatternProgressDelta["evidence"][number]) {
  return `/dashboard/games/${encodeURIComponent(entry.gameId)}?ply=${entry.ply}`;
}

function drillHref(entry: PatternProgressDelta["evidence"][number]) {
  return `${replayHref(entry)}&spar=1`;
}

function lossInPawns(cp: number) {
  return `${(cp / 100).toFixed(1)} pawns`;
}

function PhaseEvidence({ item, featured = false }: { item: PatternProgressDelta; featured?: boolean }) {
  const worst = [...item.evidence].sort((a, b) => b.cpLoss - a.cpLoss).slice(0, 3);
  const worstPosition = worst[0] ?? item.evidence[0];
  const cpChange = item.beforeAvgCp - item.afterAvgCp;
  const title = featured ? `Your biggest leak: ${phaseLabel(item.phase)}` : phaseLabel(item.phase);

  return <div className={featured ? "" : "pt-2"}>
    {featured ? <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-100">{title}</h3> : <h3 className="text-sm font-medium text-neutral-100">{phaseLabel(item.phase)} moments</h3>}
    <p className={`${featured ? "mt-3 text-base" : "mt-2 text-sm"} leading-6 text-neutral-200`}>
      Average flagged drop: <strong className="font-semibold text-white">{lossInPawns(item.beforeAvgCp)}</strong>
      <span className="ml-2 text-xs text-neutral-500">{item.beforeCount} moments across {item.beforeGameCount} {item.beforeGameCount === 1 ? "game" : "games"}</span>
    </p>
    {item.trend === "baseline" || item.trend === "untrained" ? <p className="mt-1 text-xs text-neutral-400">{item.trend === "baseline" ? "Your baseline is set. We’ll compare the next similar flagged moment." : "Practice a position below to set your baseline for future games."}</p> : <p className={`mt-1 text-xs ${TREND_STYLE[item.trend]}`}>
      Since practice, average flagged drops are {cpChange > 0 ? `down ${lossInPawns(cpChange)}` : cpChange < 0 ? `up ${lossInPawns(Math.abs(cpChange))}` : "about the same"} across {item.afterCount} later {item.afterCount === 1 ? "moment" : "moments"}.
    </p>}
    {item.afterCount > 0 && item.afterCount < 3 && <p className="mt-1 text-[11px] text-neutral-500">Early read; more later moments can change the average.</p>}

    {worst.length > 0 && <ul className="mt-4 divide-y divide-white/[0.07] border-y border-white/[0.07]">
      {worst.map((entry) => <li key={`${entry.gameId}:${entry.ply}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        <Link href={replayHref(entry)} className="inline-flex shrink-0 items-center rounded-md border border-white/15 px-2.5 py-1.5 text-[11px] text-neutral-200 hover:border-emerald-300/35 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">Replay</Link>
        <span className="min-w-0 flex-1 text-xs text-neutral-300">Move {Math.floor(entry.ply / 2) + 1} vs <span className="text-white">{entry.opponentUsername}</span></span>
        <span className="text-xs tabular-nums text-amber-100">Lost {lossInPawns(entry.cpLoss)}</span>
      </li>)}
    </ul>}

    <div className="mt-4 flex flex-wrap gap-2">
      <Link href={evidenceHref(item)} className="inline-flex items-center rounded-lg border border-white/15 bg-white/[0.03] px-3.5 py-2.5 text-xs text-neutral-200 transition hover:border-white/30 hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        See all {item.beforeCount} moments <span aria-hidden="true" className="ml-2">→</span>
      </Link>
      {worstPosition && <Link href={drillHref(worstPosition)} className="inline-flex items-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3.5 py-2.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-300/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">
        Drill this {item.phase} <span aria-hidden="true" className="ml-2">→</span>
      </Link>}
    </div>
  </div>;
}

export default function PatternProgress({ items }: { items: PatternProgressDelta[] }) {
  const ranked = [...items].sort((a, b) => b.beforeAvgCp - a.beforeAvgCp);
  const [featured, ...secondary] = ranked;

  return <section className="rounded-xl border border-white/10 bg-black/35 px-5 py-6 sm:px-6 sm:py-8">
    <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">After spar practice</p>
    <h2 className="mt-2 text-lg font-medium">Pattern progress</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">Review the games behind your biggest recurring mistakes, then practice from the exact position.</p>
    {featured ? <div className="mt-5">
      <article className="rounded-xl border border-amber-200/15 bg-amber-200/[0.035] p-4 sm:p-5">
        <PhaseEvidence item={featured} featured />
      </article>
      {secondary.length > 0 && <div className="mt-3 divide-y divide-white/10 border-t border-white/10">
        {secondary.map((item) => <details key={item.patternId} className="group py-3">
          <summary className="flex cursor-pointer list-none items-center gap-3 py-1 text-sm text-neutral-300 outline-none marker:hidden hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-300/50 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="text-neutral-500 transition group-open:rotate-90">›</span>
            <span className="flex-1">{phaseLabel(item.phase)}</span>
            <span className="text-xs tabular-nums text-neutral-500">Average: {lossInPawns(item.beforeAvgCp)}</span>
          </summary>
          <div className="px-5 pb-3 pt-4"><PhaseEvidence item={item} /></div>
        </details>)}
      </div>}
    </div> : <div className="mt-5 flex flex-col items-center justify-center rounded-lg border border-white/10 bg-white/[0.015] px-5 py-10 text-center">
      <p className="text-sm font-medium text-white">Your map is taking shape.</p>
      <p className="mt-2 max-w-md text-xs leading-5 text-neutral-400">Once evaluated games reveal a recurring flagged position, we’ll bring the exact replay here so you can review and practice it.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link href="/dashboard/games" className="rounded-lg border border-white/15 px-3.5 py-2.5 text-xs text-neutral-200 hover:bg-white/[0.06]">Review games →</Link>
        <Link href="/dashboard/signature#game-sync" className="rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3.5 py-2.5 text-xs text-emerald-100 hover:bg-emerald-300/15">Sync more games →</Link>
      </div>
    </div>}
  </section>;
}
