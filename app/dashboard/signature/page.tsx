import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/getDashboardData";
import { getPersonalRecords } from "@/lib/dashboard/getSignatureSignals";
import { getPatternsData, weaknessPatternGamesHref } from "@/lib/patterns/getPatternsData";
import { getRivalriesList } from "@/lib/rivalries/getRivalriesList";
import { prisma } from "@/lib/prisma";
import { SyncPanel } from "@/components/dashboard/SyncPanel";
import SignatureShareCard from "@/components/dashboard/SignatureShareCard";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";
import ClaimCard from "@/components/dashboard/ClaimCard";
import EarlyRead from "@/components/dashboard/EarlyRead";
import NemesisSquare from "@/components/dashboard/NemesisSquare";
import PersonalRecords from "@/components/dashboard/PersonalRecords";

export default function SignaturePage() {
  return <Suspense fallback={<DashboardPageFallback />}><SignaturePageContent /></Suspense>;
}

async function SignaturePageContent() {
  const userId = getSessionUserId(await auth());
  const [data, totalGames, patterns, records, rivalries] = await Promise.all([
    userId ? getDashboardData(userId) : Promise.resolve(null),
    userId ? prisma.game.count({ where: { userId } }) : Promise.resolve(0),
    userId ? getPatternsData(userId) : Promise.resolve(null),
    userId ? getPersonalRecords(userId) : Promise.resolve(null),
    userId ? getRivalriesList(userId) : Promise.resolve(null),
  ]);

  if (!data || !patterns || !records || !rivalries) {
    return <p className="text-sm text-neutral-400">Your account record is not available yet. Try refreshing after signing in.</p>;
  }

  const flags = data.recentFlags;
  const topSquares = [...patterns.bias.squares.blunderDensity]
    .sort((a, b) => b.flaggedCount - a.flaggedCount)
    .filter((square) => square.flaggedCount > 0)
    .slice(0, 3);

  return <div className="space-y-7 pb-12">
    <header className="flex flex-col justify-between gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-end">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Player dossier</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Your playing signature</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">A snapshot of evidence from your saved games and analysis. Signals may shift as more games are evaluated.</p>
      </div>
      <SignatureShareCard
        username={data.username}
        games={data.totalGames}
        evaluatedGames={data.evaluatedGames}
        patternCount={data.weaknessSummary.patternCount}
        topOpenings={(data.playerProfile?.mostCommonOpenings ?? []).slice(0, 3)}
        tempo={(["opening", "middlegame", "endgame"] as const).map((phase) => ({ phase, seconds: data.playerProfile?.avgMoveTimeSecByPhase[phase] ?? null }))}
      />
    </header>

    <SyncPanel initialTotalGames={totalGames} />

    <section aria-label="Signature vitals" className="grid gap-5 border-y border-white/10 py-5 sm:grid-cols-2 xl:grid-cols-4">
      <ClaimCard stat={`${data.evaluatedGames}/${data.totalGames}`} claim="Games evaluated" context={`${data.unevaluatedGames.toLocaleString()} awaiting analysis`} />
      <ClaimCard stat={String(data.recentFlags.length)} claim="Recent flagged moments" context="Saved engine findings in the latest games." />
      <ClaimCard stat={String(data.weaknessSummary.patternCount)} claim="Recurring patterns" context={`${data.weaknessSummary.gamesEvaluated} games in the weakness profile.`} />
      <ClaimCard stat={patterns.bias.meetsThreshold ? String(patterns.bias.sampleSize) : "Building"} claim="Spatial signal" context={patterns.bias.meetsThreshold ? "Flagged moves in the board-bias profile." : "More evaluated moments are needed for a stable heatmap."} />
    </section>

    <EarlyRead
      flags={flags.map((flag) => ({ gameId: flag.gameId, phase: flag.phase, cpLoss: flag.cpLoss }))}
      evaluatedGames={data.evaluatedGames}
      totalGames={data.totalGames}
    />

    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3 border-b border-white/10 pb-2">
        <div><p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Repeated signals</p><h2 className="mt-1 text-lg font-medium">Patterns in your games</h2></div>
        <Link href="/dashboard/signature/patterns" className="text-xs text-neutral-400 hover:text-white">All patterns →</Link>
      </div>
      {patterns.weaknessPatterns.length ? <ul className="divide-y divide-white/[0.07]">
        {patterns.weaknessPatterns.slice(0, 5).map((pattern) => {
          const href = weaknessPatternGamesHref(pattern.occurrences);
          return <li key={pattern.id} className="flex items-start gap-4 py-3">
            <span className="min-w-0 flex-1 text-sm leading-5 text-neutral-200">{pattern.description}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-400">×{pattern.occurrenceCount}</span>
            {href ? <Link href={href} className="shrink-0 text-xs text-emerald-200 hover:text-white">Review →</Link> : <span className="shrink-0 text-xs text-neutral-600">No linked games</span>}
          </li>;
        })}
      </ul> : <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs leading-5 text-neutral-500">No recurring patterns are persisted yet. Sync and evaluate more games to build evidence.</p>}
    </section>

    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3 border-b border-white/10 pb-2">
        <div><p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Board bias</p><h2 className="mt-1 text-lg font-medium">Most flagged destination squares</h2></div>
        <Link href="/dashboard/signature/heatmap" className="text-xs text-neutral-400 hover:text-white">Open heatmap →</Link>
      </div>
      {topSquares.length ? <ol className="divide-y divide-white/[0.07]">
        {topSquares.map((square) => <li key={square.square} className="flex items-center justify-between gap-3 py-3 text-sm">
          <span className="font-mono text-rose-200">{square.square}</span>
          <span className="text-xs text-neutral-400">{square.flaggedCount} flagged moves{square.avgCpLoss === null ? "" : ` · ${Math.round(square.avgCpLoss)} cp average`}</span>
        </li>)}
      </ol> : <p className="text-xs leading-5 text-neutral-500">{patterns.bias.meetsThreshold ? "No flagged destination square stands out yet." : `Building a stable signal: ${patterns.bias.sampleSize} of 20 flagged moves.`}</p>}
    </section>

    <NemesisSquare data={patterns.bias} />
    <PersonalRecords records={records} />

    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3 border-b border-white/10 pb-2">
        <div><p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Rivalries</p><h2 className="mt-1 text-lg font-medium">Opponents you have faced repeatedly</h2></div>
        <Link href="/dashboard/signature/rivalries" className="text-xs text-neutral-400 hover:text-white">All rivalries →</Link>
      </div>
      {rivalries.length ? <ul className="divide-y divide-white/[0.07]">
        {rivalries.slice(0, 3).map((rivalry) => <li key={rivalry.opponentUsername.toLowerCase()} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
          <Link href={`/dashboard/signature/rivalries/${encodeURIComponent(rivalry.opponentUsername)}`} className="text-neutral-200 hover:text-white">vs {rivalry.opponentUsername}</Link>
          <span className="text-xs text-neutral-500">{rivalry.wins}W {rivalry.losses}L {rivalry.draws}D</span>
        </li>)}
      </ul> : <p className="text-xs text-neutral-500">No repeated losses to one opponent yet.</p>}
    </section>

    <section className="border-t border-white/10 pt-5">
      <h2 className="mb-1 text-xs font-medium uppercase tracking-widest text-neutral-500">Explore your analysis</h2>
      <div className="divide-y divide-white/[0.07]">
        {[
          { href: "/dashboard/signature/patterns", title: "Blind spots", detail: "Recurring patterns and where flagged moves cluster" },
          { href: "/dashboard/practice/openings", title: "Openings", detail: "Your repertoire, results, and Danger Score" },
          { href: "/dashboard/practice/form", title: "Form", detail: "Trends and tempo across your saved games" },
          { href: "/dashboard/signature/style-match", title: "Style match", detail: "Compare your wins with the historical style library" },
        ].map((item) => <Link key={item.href} href={item.href} className="group flex items-center gap-4 py-4 transition-colors hover:text-white">
          <span className="min-w-0 flex-1"><span className="block text-sm text-neutral-200 group-hover:text-white">{item.title}</span><span className="mt-1 block text-xs text-neutral-500">{item.detail}</span></span>
          <span aria-hidden="true" className="text-neutral-600 transition group-hover:translate-x-1 group-hover:text-emerald-200">→</span>
        </Link>)}
      </div>
    </section>
  </div>;
}
