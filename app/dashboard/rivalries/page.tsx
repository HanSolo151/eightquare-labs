import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getRivalriesList } from "@/lib/rivalries/getRivalriesList";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function RivalriesPage() {
  return <Suspense fallback={<DashboardPageFallback />}><RivalriesPageContent /></Suspense>;
}

async function RivalriesPageContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your rivalries.</p>;
  const rivalries = await getRivalriesList(userId);
  return <div className="space-y-6 pb-12">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Rivalries</p>
      <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Repeated losses</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">Built entirely from your own game history — nothing here is visible to anyone but you.</p>
    </header>
    {rivalries.length === 0 ? <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs text-neutral-500">No repeated losses to one opponent yet.</p> : (
      <ol className="grid gap-3 sm:grid-cols-2">
        {rivalries.map((rivalry) => <li key={rivalry.opponentUsername.toLowerCase()}>
          <Link href={`/dashboard/rivalries/${encodeURIComponent(rivalry.opponentUsername)}`} className="block rounded-xl border border-white/10 bg-black/35 p-4 hover:bg-white/[0.03]">
            <p className="text-sm text-neutral-100">vs {rivalry.opponentUsername}</p>
            <p className="mt-1 text-xs text-neutral-500">{rivalry.wins}W {rivalry.losses}L {rivalry.draws}D</p>
            <p className="mt-2 text-xs text-neutral-400">{rivalry.summary}</p>
          </Link>
        </li>)}
      </ol>
    )}
  </div>;
}
