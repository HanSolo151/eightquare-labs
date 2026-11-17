import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPatternsData, weaknessPatternGamesHref, weaknessPatternTagHref } from "@/lib/patterns/getPatternsData";
import BlindSpotsExplorer from "@/components/dashboard/BlindSpotsExplorer";
import PatternProgress from "@/components/dashboard/PatternProgress";
import { getPatternProgressDeltas } from "@/lib/dashboard/getSignatureSignals";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function SignaturePatternsPage() {
  return <Suspense fallback={<DashboardPageFallback />}><PatternsPageContent /></Suspense>;
}

async function PatternsPageContent() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return <EmptyState />;
  const [data, patternProgress] = await Promise.all([
    getPatternsData(userId),
    getPatternProgressDeltas(userId),
  ]);

  return (
    <div className="space-y-7 pb-12">
      <header className="flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Spatial and recurring signals</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Blind Spots</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">Explore where flagged moves cluster, how they vary by phase and severity, and which recurring patterns have evidence in your saved games.</p>
        </div>
        <div className="text-xs text-neutral-400"><span className="text-white">{data.meta.gamesEvaluated}</span> / {data.meta.gamesFetched} evaluated · weakness profile <span className="capitalize">{data.meta.confidence}</span> confidence</div>
      </header>

      <BlindSpotsExplorer bias={data.bias} heatmap={data.heatmap} />

      <PatternProgress items={patternProgress} />

      <div className="grid gap-7 border-t border-white/10 pt-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section>
          <SectionTitle eyebrow="Phase level signals" title="Unrecovered eval losses" detail="Repeated large evaluation losses grouped by game phase; these are not tactical motif detections." />
          {data.weaknessPatterns.length === 0 ? <Empty>No repeated weakness patterns have been persisted yet.</Empty> : <ol className="mt-4 divide-y divide-white/[0.07] border-t border-white/[0.07]">
            {data.weaknessPatterns.map((pattern) => {
              const gamesHref = weaknessPatternGamesHref(pattern.occurrences);
              return <li key={pattern.id} className="py-4">
              <div className="flex items-start justify-between gap-3"><p className="text-sm leading-5 text-neutral-100">{pattern.description}</p>{gamesHref ? <Link href={gamesHref} aria-label={`Review ${pattern.occurrenceCount} occurrences of ${pattern.description}`} className="shrink-0 font-mono text-xs text-neutral-400 hover:text-white">×{pattern.occurrenceCount} →</Link> : <span className="shrink-0 font-mono text-xs text-neutral-500">×{pattern.occurrenceCount}</span>}</div>
              {pattern.tags.length > 0 && <ul className="mt-3 flex flex-wrap gap-1.5">{pattern.tags.map((tag) => {
                const tagHref = weaknessPatternTagHref(tag, pattern.occurrences);
                return <li key={tag}>{tagHref
                  ? <Link href={tagHref} className="rounded bg-white/5 px-2 py-1 text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" aria-label={`Filter this pattern's games by ${tag}`}>{tag}</Link>
                  : <span className="rounded bg-white/5 px-2 py-1 text-[10px] text-neutral-400">{tag}</span>}
                </li>;
              })}</ul>}
              {gamesHref && <p className="mt-3"><Link href={gamesHref} className="text-[11px] text-neutral-400 hover:text-white">Review matching games and moves</Link></p>}
              <p className="mt-3 text-[10px] text-neutral-600">Seen {new Date(pattern.firstSeenAt).toLocaleDateString()} – {new Date(pattern.lastSeenAt).toLocaleDateString()}</p>
            </li>;})}
          </ol>}
        </section>

        <section className="border-t border-white/10 pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
          <SectionTitle eyebrow="Spatial tendencies" title="Board bias" detail="Square-level move and flag records aggregated by rank, file, and diagonal." />
          {data.bias.meetsThreshold ? <div className="mt-5 border-t border-white/[0.07] pt-4">
            <p className="text-sm text-neutral-200">Computed from {data.bias.sampleSize} flagged moves</p>
            {data.bias.caption && <p className="mt-2 text-xs leading-5 text-neutral-400">{data.bias.caption}</p>}
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {([ ["Ranks", data.bias.axes.ranks], ["Files", data.bias.axes.files], ["Diagonals", data.bias.axes.diagonals] ] as const).map(([title, entries]) => (
                <div key={title}>
                  <h3 className="text-xs font-medium text-neutral-200">{title}</h3>
                  {entries.length > 0 ? <ul className="mt-2 space-y-1.5">
                    {entries.slice(0, 3).map((entry) => <li key={entry.label} className="flex justify-between gap-2 text-[11px] text-neutral-400">
                      <span>{entry.label}</span><span className="shrink-0 font-mono tabular-nums">{(entry.flaggedRate * 100).toFixed(1)}% <span className="text-neutral-600">({entry.flaggedCount}/{entry.moveCount})</span></span>
                    </li>)}
                  </ul> : <p className="mt-2 text-[11px] leading-4 text-neutral-500">No aggregate has enough moves yet.</p>}
                </div>
              ))}
            </div>
          </div> : <Empty>{`Not enough flagged moves yet: sample ${data.bias.sampleSize} of 20 required. Sync and evaluate more games to build a stable board-bias profile.`}</Empty>}
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
