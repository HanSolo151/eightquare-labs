import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPatternsData } from "@/lib/patterns/getPatternsData";
import BlindSpotsExplorer from "@/components/dashboard/BlindSpotsExplorer";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function SignatureHeatmapPage() {
  return <Suspense fallback={<DashboardPageFallback />}><SignatureHeatmapContent /></Suspense>;
}

async function SignatureHeatmapContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your heatmap.</p>;
  const data = await getPatternsData(userId);

  return <section className="space-y-5 pb-12">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Spatial and recurring signals</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Heatmap</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-400">Explore where flagged moves cluster across the board and by phase or severity.</p>
    </header>
    <BlindSpotsExplorer bias={data.bias} heatmap={data.heatmap} />
  </section>;
}
