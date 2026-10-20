import Link from "next/link";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { getGhostMoment } from "@/lib/ghost/getGhostMoment";
import { getSparQueue } from "@/lib/dashboard/getSparQueue";
import GhostReplay from "@/components/board/GhostReplay";

export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to continue.</p>;

  const [recentGame, queue] = await Promise.all([
    prisma.game.findFirst({
      where: { userId, flags: { some: {} } },
      orderBy: [{ lichessCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { id: true },
    }),
    getSparQueue(userId),
  ]);
  const moment = recentGame ? await getGhostMoment(userId, recentGame.id) : null;

  return <div className="space-y-8 pb-12">
    <header className="border-b border-white/10 pb-6">
      <h1 className="text-2xl font-semibold sm:text-3xl">The moment it went wrong</h1>
      <p className="mt-2 text-sm text-neutral-400">Review a recent flagged position, then play it against Maia or an available opponent mimic.</p>
    </header>

    {moment ? <section>
      <GhostReplay key={`${moment.gameId}:${moment.ply}`} moment={moment} />
      <div className="mt-5">
        <Link href={`/dashboard/games/${encodeURIComponent(moment.gameId)}/ghost?ply=${moment.ply}`} className="inline-flex rounded-lg border border-amber-400/30 bg-amber-400/10 px-5 py-2.5 text-sm text-amber-200 hover:bg-amber-400/20">
          Start this spar
        </Link>
      </div>
    </section> : <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs text-neutral-500">No flagged moments yet. Sync and analyze some games first.</p>}

    {queue.length > 0 && <section>
      <p className="text-xs uppercase tracking-widest text-neutral-500">Open flagged moments</p>
      <p className="mt-1 text-xs text-neutral-500">Solved moments are hidden from this list.</p>
      <ol className="mt-3 divide-y divide-white/10">
        {queue.map((item) => <li key={`${item.gameId}:${item.ply}`}>
          <Link href={`/dashboard/games/${encodeURIComponent(item.gameId)}/ghost?ply=${item.ply}`} className="flex items-center justify-between gap-3 py-3 text-sm text-neutral-200 hover:text-white">
            <span>{item.summary}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">{item.severity}</span>
          </Link>
        </li>)}
      </ol>
    </section>}

    <section className="grid gap-3 sm:grid-cols-2">
      <Link href="/dashboard/signature" className="rounded-xl border border-white/10 bg-black/35 p-4 text-sm text-neutral-300 hover:bg-white/[0.03]">Your playing signature →</Link>
      <Link href="/dashboard/daily" className="rounded-xl border border-white/10 bg-black/35 p-4 text-sm text-neutral-300 hover:bg-white/[0.03]">Today’s puzzle →</Link>
    </section>
  </div>;
}
