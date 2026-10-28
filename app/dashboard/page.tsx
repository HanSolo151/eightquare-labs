import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { getGhostMoment } from "@/lib/ghost/getGhostMoment";
import { getSparQueue } from "@/lib/dashboard/getSparQueue";
import { getNearMisses } from "@/lib/ghost/getNearMisses";
import GhostReplay from "@/components/board/GhostReplay";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function DashboardPage() {
  return <Suspense fallback={<DashboardPageFallback />}><DashboardPageContent /></Suspense>;
}

async function DashboardPageContent() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to continue.</p>;

  const [recentGame, progress, nearMisses] = await Promise.all([
    prisma.game.findFirst({
      where: {
        userId,
        OR: [
          { playerColor: "white", flags: { some: { color: "white" } } },
          { playerColor: "black", flags: { some: { color: "black" } } },
        ],
      },
      orderBy: [{ lichessCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { id: true },
    }),
    getSparQueue(userId),
    getNearMisses(userId),
  ]);
  const moment = recentGame ? await getGhostMoment(userId, recentGame.id) : null;

  return <div className="space-y-8 pb-12">
    <header className="border-b border-white/10 pb-6">
      <h1 className="text-2xl font-semibold sm:text-3xl">The moment it went wrong</h1>
      <p className="mt-2 text-sm text-neutral-400">Review a recent flagged position, then play it against Maia or an available opponent mimic.</p>
    </header>

    {moment ? <section>
      <GhostReplay key={`${moment.gameId}:${moment.ply}`} moment={moment} nearMisses={nearMisses} />
      <div className="mt-5">
        <Link href={`/dashboard/games/${encodeURIComponent(moment.gameId)}/ghost?ply=${moment.ply}`} className="inline-flex rounded-lg border border-amber-400/30 bg-amber-400/10 px-5 py-2.5 text-sm text-amber-200 hover:bg-amber-400/20">
          Start this spar
        </Link>
      </div>
    </section> : <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs text-neutral-500">No flagged moments yet. Sync and analyze some games first.</p>}

    <section className="rounded-xl border border-white/10 bg-black/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-neutral-500">Your practice progress</p>
          <h2 className="mt-1 text-lg font-medium text-neutral-100">{!progress.trackingAvailable ? "Progress tracking is unavailable" : progress.flagged ? `${progress.resolved} of ${progress.flagged} flagged positions marked resolved` : "No flagged positions yet"}</h2>
        </div>
        {progress.trackingAvailable && <p className="font-mono text-xs tabular-nums text-neutral-400">{progress.total} to revisit</p>}
      </div>
      {progress.trackingAvailable ? <>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Personal flagged-position progress" aria-valuemin={0} aria-valuemax={Math.max(progress.flagged, 1)} aria-valuenow={progress.resolved}>
          <div className="h-full rounded-full bg-emerald-300 transition-[width]" style={{ width: `${progress.flagged ? (progress.resolved / progress.flagged) * 100 : 0}%` }} />
        </div>
        <p className="mt-2 text-[11px] leading-5 text-neutral-500">Personal checklist across Daily Puzzle and spar. A resolved marker tracks practice activity; it does not verify skill or whether Stockfish assist was used.</p>
      </> : <p className="mt-2 text-[11px] leading-5 text-amber-200/80">The database is missing practice-tracking tables. Flagged positions remain available below; apply the pending Prisma migrations to restore progress and resolved-position tracking.</p>}
    </section>

    {progress.items.length > 0 && <section>
      <p className="text-xs uppercase tracking-widest text-neutral-500">Positions to revisit</p>
      <p className="mt-1 text-xs text-neutral-500">Resolved positions are hidden from this list.</p>
      <ol className="mt-3 divide-y divide-white/10">
        {progress.items.map((item) => <li key={`${item.gameId}:${item.ply}`}>
          <Link href={`/dashboard/games/${encodeURIComponent(item.gameId)}/ghost?ply=${item.ply}`} className="flex items-center justify-between gap-3 py-3 text-sm text-neutral-200 hover:text-white">
            <span>{item.summary}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">{item.severity}</span>
          </Link>
        </li>)}
      </ol>
      {progress.total > progress.items.length && <p className="mt-2 text-xs text-neutral-500">Showing {progress.items.length} of {progress.total} positions to revisit.</p>}
    </section>}

    <section className="grid gap-3 sm:grid-cols-2">
      <Link href="/dashboard/signature" className="rounded-xl border border-white/10 bg-black/35 p-4 text-sm text-neutral-300 hover:bg-white/[0.03]">Your playing signature →</Link>
      <Link href="/dashboard/daily" className="rounded-xl border border-white/10 bg-black/35 p-4 text-sm text-neutral-300 hover:bg-white/[0.03]">Today’s puzzle →</Link>
    </section>
  </div>;
}
