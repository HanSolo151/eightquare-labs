import Link from "next/link";
import { Fragment } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPatternsData } from "@/lib/patterns/getPatternsData";

export const instant = false;

const PHASES = ["opening", "middlegame", "endgame"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;
const phaseName: Record<(typeof PHASES)[number], string> = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };
const severityStyle: Record<(typeof SEVERITIES)[number], { text: string; cell: string }> = {
  high: { text: "text-rose-200", cell: "bg-rose-400" },
  medium: { text: "text-amber-100", cell: "bg-amber-300" },
  low: { text: "text-sky-100", cell: "bg-sky-300" },
};

export default async function PatternsPage() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return <EmptyState />;
  const data = await getPatternsData(userId);
  const maxFlags = Math.max(1, ...PHASES.flatMap((phase) => SEVERITIES.map((severity) => data.heatmap[phase][severity])));

  return (
    <div className="space-y-7 pb-12">
      <header className="flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Pattern atlas / 03</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Patterns</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">Where your saved analysis clusters across openings, game phases, and recurring weaknesses.</p>
        </div>
        <div className="text-xs text-neutral-400"><span className="text-white">{data.meta.gamesEvaluated}</span> / {data.meta.gamesFetched} evaluated · <span className="capitalize">{data.meta.confidence}</span> confidence</div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
          <SectionTitle eyebrow="Opening performance" title="Flagged games by opening" detail="Ranked by the share of games with at least one stored flag. A minimum of two games is required." />
          {data.openings.length === 0 ? <Empty>No opening has enough games for a stable comparison yet. Sync and evaluate more games to populate this view.</Empty> : (
            <ol className="mt-6 space-y-5">
              {data.openings.map((opening, index) => <li key={`${opening.eco}-${opening.name}`}>
                <div className="mb-2 flex items-baseline gap-3">
                  <span className="w-6 font-mono text-xs text-emerald-300">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-100">{opening.name}<span className="ml-2 text-xs text-neutral-500">{opening.eco ?? ""}</span></p>
                    <p className="mt-1 text-[11px] text-neutral-500">{opening.flaggedGameCount} of {opening.gamesPlayed} games flagged · {opening.flagCount} total flags · {opening.avgCpLoss} average cp loss</p>
                  </div>
                  <span className="font-mono text-sm tabular-nums text-neutral-200">{Math.round(opening.blunderRate * 100)}%</span>
                </div>
                <div className="ml-9 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-amber-300" style={{ width: `${Math.max(2, opening.blunderRate * 100)}%` }} /></div>
              </li>)}
            </ol>
          )}
        </section>

        <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
          <SectionTitle eyebrow="Flag distribution" title="Phase × severity" detail="Counts of persisted flags. Cell brightness tracks the largest count in this matrix." />
          <div className="mt-6 grid grid-cols-[minmax(96px,1fr)_repeat(3,minmax(48px,0.7fr))] gap-2 text-center">
            <div />
            {SEVERITIES.map((severity) => <div key={severity} className={`pb-1 text-[10px] uppercase tracking-wider ${severityStyle[severity].text}`}>{severity}</div>)}
            {PHASES.map((phase) => <Fragment key={phase}>
              <div key={`${phase}-label`} className="flex items-center text-left text-xs text-neutral-300">{phaseName[phase]}</div>
              {SEVERITIES.map((severity) => {
                const count = data.heatmap[phase][severity];
                const opacity = count ? 0.18 + (count / maxFlags) * 0.78 : 0.035;
                return <div key={`${phase}-${severity}`} className="flex aspect-square max-h-20 items-center justify-center rounded-lg border border-white/5 font-mono text-sm tabular-nums text-white" style={{ backgroundColor: `color-mix(in srgb, ${severity === "high" ? "#fb7185" : severity === "medium" ? "#fcd34d" : "#7dd3fc"} ${Math.round(opacity * 100)}%, transparent)` }} aria-label={`${phaseName[phase]}, ${severity}: ${count} flags`} title={`${phaseName[phase]} · ${severity}: ${count}`}>{count}</div>;
              })}
            </Fragment>)}
          </div>
          <p className="mt-5 text-[11px] leading-5 text-neutral-500">These are raw counts, not rates. Phases with more recorded moves can naturally contribute more flags.</p>
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
          <SectionTitle eyebrow="Recurring signals" title="Weakness patterns" detail="Repeated patterns accumulated from evaluated games." />
          {data.weaknessPatterns.length === 0 ? <Empty>No repeated weakness patterns have been persisted yet.</Empty> : <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {data.weaknessPatterns.map((pattern) => <article key={pattern.id} className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
              <div className="flex items-start justify-between gap-3"><p className="text-sm leading-5 text-neutral-100">{pattern.description}</p><span className="shrink-0 rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] text-neutral-300">×{pattern.occurrenceCount}</span></div>
              {pattern.tags.length > 0 && <ul className="mt-3 flex flex-wrap gap-1.5">{pattern.tags.map((tag) => <li key={tag} className="rounded bg-white/5 px-2 py-1 text-[10px] text-neutral-400">{tag}</li>)}</ul>}
              <p className="mt-3 text-[10px] text-neutral-600">Seen {new Date(pattern.firstSeenAt).toLocaleDateString()} – {new Date(pattern.lastSeenAt).toLocaleDateString()}</p>
            </article>)}
          </div>}
        </section>

        <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
          <SectionTitle eyebrow="Spatial tendencies" title="Board bias" detail="Rank, file, and diagonal tendencies need their own validated analysis pass." />
          {data.bias.built ? <div className="mt-5 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.04] p-4">
            <p className="text-sm text-neutral-200">Stored analysis · sample {data.bias.sampleSize} · {data.bias.confidence} confidence</p>
            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-neutral-500">{JSON.stringify({ rank: data.bias.rankBias, file: data.bias.fileBias, diagonal: data.bias.diagonalBias }, null, 2)}</pre>
          </div> : <div className="mt-5 rounded-lg border border-dashed border-white/15 p-5">
            <p className="text-sm text-neutral-200">Analysis not built yet</p>
            <p className="mt-2 text-xs leading-5 text-neutral-500">No spatial-bias engine has produced data. This panel stays empty until that analysis is implemented and validated; it does not infer tendencies from unrelated metrics.</p>
          </div>}
          <Link href="/dashboard/games" className="mt-5 inline-flex text-xs text-emerald-300 hover:text-emerald-200">Explore the game archive <span aria-hidden="true" className="ml-2">→</span></Link>
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div><p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">{eyebrow}</p><h2 className="mt-2 text-lg font-medium">{title}</h2><p className="mt-1 text-xs leading-5 text-neutral-500">{detail}</p></div>;
}

function Empty({ children }: { children: string }) {
  return <p className="mt-5 rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs leading-5 text-neutral-500">{children}</p>;
}

function EmptyState() {
  return <section className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center"><p className="text-lg">Session unavailable</p><p className="mt-2 text-sm text-neutral-500">Sign in again to view persisted pattern data.</p></section>;
}
