import Link from "next/link";
import { auth } from "@/lib/auth";
import { getSessionUserId, getSessionPlan } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/getDashboardData";
import { prisma } from "@/lib/prisma";
import { SyncPanel } from "@/components/dashboard/SyncPanel";

export const instant = false;

const PHASES = ["opening", "middlegame", "endgame"] as const;
const severityClass: Record<string, string> = {
  high: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  medium: "border-amber-300/30 bg-amber-300/10 text-amber-100",
  low: "border-sky-300/20 bg-sky-300/10 text-sky-100",
};

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(date: Date | null) {
  if (!date) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default async function DashboardPage() {
  const session = await auth();
  const userId = getSessionUserId(session);
  const [data, totalGames] = await Promise.all([
    userId ? getDashboardData(userId) : Promise.resolve(null),
    userId ? prisma.game.count({ where: { userId } }) : Promise.resolve(0),
  ]);

  return (
    <div className="space-y-8 pb-12">
      <section className="flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Player dossier / 01</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Your playing signature</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">
            A record of your decisions, timing, and recurring patterns, built from games you have synced and evaluated.
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-xs uppercase tracking-widest text-neutral-500">Plan</p>
          <p className="mt-1 text-sm capitalize text-neutral-200">{getSessionPlan(session)}</p>
        </div>
      </section>

      <SyncPanel initialTotalGames={totalGames} autoSyncOnMount />

      {!data ? (
        <section className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-neutral-400">
          Your account record is not available yet. Try refreshing after signing in.
        </section>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Games in archive" value={data.totalGames.toLocaleString()} note="Synced to your account" />
            <Metric label="Evaluated" value={data.evaluatedGames.toLocaleString()} note={`${data.unevaluatedGames} waiting for analysis`} />
            <Metric label="Premove rate" value={data.playerProfile ? pct(data.playerProfile.premoveRate) : "—"} note="Estimated from clock data" />
            <Metric label="Average opponent" value={data.playerProfile?.avgOpponentRating?.toLocaleString() ?? "—"} note="Rating at game time" />
          </section>

          <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
            <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
              <SectionHeading eyebrow="Tempo profile" title="Time by phase" detail="Average time spent per move, where clock data is available." />
              <div className="mt-7 space-y-5">
                {PHASES.map((phase) => {
                  const seconds = data.playerProfile?.avgMoveTimeSecByPhase[phase] ?? null;
                  const max = Math.max(...PHASES.map((p) => data.playerProfile?.avgMoveTimeSecByPhase[p] ?? 0), 1);
                  return <div key={phase}>
                    <div className="mb-2 flex justify-between text-xs">
                      <span className="capitalize text-neutral-300">{phase}</span>
                      <span className="tabular-nums text-neutral-400">{seconds === null ? "No sample" : `${seconds.toFixed(1)} sec / move`}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-300" style={{ width: `${seconds === null ? 0 : Math.max(4, seconds / max * 100)}%` }} />
                    </div>
                  </div>;
                })}
              </div>
              <p className="mt-5 text-xs text-neutral-500">Profile coverage: {data.playerProfile?.gamesAnalyzed ?? 0} games. Timing is descriptive, not a rating of move quality.</p>
            </section>

            <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
              <SectionHeading eyebrow="Opening repertoire" title="Most played" detail="Your most frequent recorded openings." />
              {!data.playerProfile?.mostCommonOpenings.length ? <Empty>No opening profile yet. Sync games and let analysis finish to build this section.</Empty> : (
                <ol className="mt-5 divide-y divide-white/10">
                  {data.playerProfile.mostCommonOpenings.slice(0, 5).map((opening, index) => (
                    <li key={`${opening.eco}-${opening.name}`} className="flex items-center gap-4 py-3 first:pt-0">
                      <span className="font-mono text-xs text-emerald-300">0{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-neutral-100">{opening.name}</p>
                        <p className="mt-1 text-xs text-neutral-500">{opening.eco || "ECO unavailable"}</p>
                      </div>
                      <span className="text-sm tabular-nums text-neutral-300">{opening.count}<span className="ml-1 text-xs text-neutral-500">games</span></span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
            <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
              <SectionHeading eyebrow="Model confidence" title="Repeated patterns" detail="Only recurring signals from evaluated games are shown." />
              <div className="mt-5 flex items-end justify-between border-t border-white/10 pt-4">
                <div><p className="text-3xl font-semibold tabular-nums">{data.weaknessSummary.patternCount}</p><p className="mt-1 text-xs text-neutral-500">patterns observed</p></div>
                <span className={`rounded-full border px-3 py-1 text-xs capitalize ${data.weaknessSummary.confidence === "high" ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" : "border-white/10 text-neutral-300"}`}>{data.weaknessSummary.confidence} confidence</span>
              </div>
              <p className="mt-4 text-xs leading-5 text-neutral-500">Based on {data.weaknessSummary.gamesEvaluated} evaluated of {data.weaknessSummary.gamesFetched} available games.</p>
              <Link href="/dashboard/patterns" className="mt-5 inline-flex text-xs text-emerald-300 hover:text-emerald-200">Inspect patterns <span aria-hidden="true" className="ml-2">↗</span></Link>
            </section>

            <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <SectionHeading eyebrow="Recent analysis" title="Flagged moments" detail={`Last sync: ${formatDate(data.lastSyncedAt)}`} />
                <Link href="/dashboard/games" className="shrink-0 text-xs text-neutral-400 hover:text-white">All games →</Link>
              </div>
              {data.recentFlags.length === 0 ? <Empty>No flagged moments stored yet. This becomes informative after game evaluation is persisted.</Empty> : (
                <ul className="mt-5 divide-y divide-white/10">
                  {data.recentFlags.slice(0, 5).map((flag, index) => (
                    <li key={`${flag.gameId}-${flag.ply}-${flag.flagType}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0">
                      <span className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wider ${severityClass[flag.severity] ?? "border-white/10 text-neutral-300"}`}>{flag.severity}</span>
                      <span className="font-mono text-sm text-white">{flag.san}</span>
                      <span className="text-xs text-neutral-400">move {flag.moveNumber} · vs {flag.opponentUsername}</span>
                      <span className="ml-auto font-mono text-xs tabular-nums text-neutral-300">−{Math.round(flag.cpLoss)} cp</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="rounded-xl border border-white/10 bg-white/[0.035] p-5">
    <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">{label}</p>
    <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
    <p className="mt-2 text-xs text-neutral-500">{note}</p>
  </article>;
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div><p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">{eyebrow}</p><h2 className="mt-2 text-lg font-medium">{title}</h2><p className="mt-1 text-xs leading-5 text-neutral-500">{detail}</p></div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs leading-5 text-neutral-500">{children}</p>;
}
