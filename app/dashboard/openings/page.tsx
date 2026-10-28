import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getOpeningsData } from "@/lib/openings/getOpeningsData";
import OpeningGambit from "@/components/dashboard/OpeningGambit";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

const badgeClass = {
  danger: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  shaky: "border-amber-300/30 bg-amber-300/10 text-amber-100",
  safe: "border-sky-300/20 bg-sky-300/10 text-sky-100",
} as const;

export default function OpeningsPage() {
  return <Suspense fallback={<DashboardPageFallback />}><OpeningsPageContent /></Suspense>;
}

async function OpeningsPageContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your openings.</p>;
  const openings = await getOpeningsData(userId);

  return (
    <div className="space-y-6 pb-12">
      <header className="border-b border-white/10 pb-6">
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Opening danger / 03</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Opening Danger Score</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">A relative ranking within your openings, combining cp loss per move, loss rate, and flagged move density. It is descriptive, not a prediction.</p>
      </header>
      <OpeningGambit openings={openings} />
      {openings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs text-neutral-500">Not enough games per opening yet (minimum 2) to rank anything.</p>
      ) : (
        <ol className="divide-y divide-white/10">
          {openings.map((opening) => (
            <li key={opening.eco ?? opening.name}>
              <div className="flex items-center gap-4 py-4">
                <span className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wider ${badgeClass[opening.badge]}`}>{opening.badge}</span>
                <div className="min-w-0 flex-1">
                  {opening.eco ? <Link className="truncate text-sm text-neutral-100 hover:text-emerald-200" href={`/dashboard/openings/${encodeURIComponent(opening.eco)}`}>{opening.name}</Link> : <p className="truncate text-sm text-neutral-100">{opening.name}</p>}
                  <p className="mt-1 text-xs text-neutral-500">{opening.eco ?? "ECO unavailable · drill-down unavailable"} · {opening.gamesPlayed} games</p>
                </div>
                <div className="text-right text-xs text-neutral-400">
                  <p>{opening.avgCpLoss.toFixed(1)} cp loss / move</p>
                  <p className="mt-1">{Math.round(opening.lossRate * 100)}% loss · {opening.flagCount} flagged plies</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
