import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/getDashboardData";
import { prisma } from "@/lib/prisma";
import { SyncPanel } from "@/components/dashboard/SyncPanel";
import SignatureShareCard from "@/components/dashboard/SignatureShareCard";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function SignaturePage() {
  return <Suspense fallback={<DashboardPageFallback />}><SignaturePageContent /></Suspense>;
}

async function SignaturePageContent() {
  const session = await auth();
  const userId = getSessionUserId(session);
  const [data, totalGames] = await Promise.all([
    userId ? getDashboardData(userId) : Promise.resolve(null),
    userId ? prisma.game.count({ where: { userId } }) : Promise.resolve(0),
  ]);

  if (!data) {
    return <p className="text-sm text-neutral-400">Your account record is not available yet. Try refreshing after signing in.</p>;
  }

  const cards = [
    { href: "/dashboard/patterns", title: "Blind spots", detail: "Recurring patterns and where flagged moves cluster" },
    { href: "/dashboard/openings", title: "Openings", detail: "Your repertoire, results, and Danger Score" },
    { href: "/dashboard/form", title: "Form", detail: "Trends, tempo, and personal records" },
    { href: "/dashboard/wins", title: "Style match", detail: "Compare your wins with the historical style library" },
  ];

  return <div className="space-y-7 pb-12">
    <header className="flex flex-col justify-between gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-end">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Player dossier</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Your playing signature</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">A snapshot of your saved games and analysis.</p>
      </div>
      <div className="flex items-center gap-4">
        <SignatureShareCard
          username={data.username}
          games={data.totalGames}
          evaluatedGames={data.evaluatedGames}
          patternCount={data.weaknessSummary.patternCount}
          topOpenings={(data.playerProfile?.mostCommonOpenings ?? []).slice(0, 3)}
          tempo={(["opening", "middlegame", "endgame"] as const).map((phase) => ({ phase, seconds: data.playerProfile?.avgMoveTimeSecByPhase[phase] ?? null }))}
        />
      </div>
    </header>

    <SyncPanel initialTotalGames={totalGames} />

    <p className="text-xs text-neutral-500">
      <span className="text-neutral-200">{data.totalGames.toLocaleString()}</span> games
      <span className="mx-2 text-neutral-700">·</span>
      <span className="text-neutral-200">{data.evaluatedGames.toLocaleString()}</span> evaluated
      <span className="mx-2 text-neutral-700">·</span>
      <span className="text-neutral-200">{data.unevaluatedGames.toLocaleString()}</span> awaiting analysis
    </p>

    <section aria-label="Explore your analysis">
      <h2 className="mb-1 text-xs font-medium uppercase tracking-widest text-neutral-500">Explore your analysis</h2>
      <div className="divide-y divide-white/[0.07]">
        {cards.map((item) => <Link key={item.href} href={item.href} className="group flex items-center gap-4 py-4 transition-colors hover:text-white">
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-neutral-200 group-hover:text-white">{item.title}</span>
            <span className="mt-1 block text-xs text-neutral-500">{item.detail}</span>
          </span>
          <span aria-hidden="true" className="text-neutral-600 transition group-hover:translate-x-1 group-hover:text-emerald-200">→</span>
        </Link>)}
      </div>
    </section>
  </div>;
}
