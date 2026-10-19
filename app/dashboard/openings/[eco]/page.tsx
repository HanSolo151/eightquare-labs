import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getOpeningDrilldown } from "@/lib/openings/getOpeningDrilldown";
import { OpeningDrilldownClient } from "@/components/dashboard/OpeningDrilldownClient";

export const instant = false;

export default async function OpeningDrilldownPage({ params }: { params: Promise<{ eco: string }> }) {
  const [{ eco }, session] = await Promise.all([params, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();
  if (!/^[A-E]\d{2}$/i.test(eco)) notFound();
  const data = await getOpeningDrilldown(userId, eco.toUpperCase());
  if (!data) notFound();
  const initialNode = data.dangerMove ?? data.nodes[0] ?? null;

  return <div className="space-y-6 pb-12">
    <Link href="/dashboard/openings" className="inline-flex text-xs text-neutral-400 hover:text-white">← Back to openings</Link>
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Opening drill-down</p>
      <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{data.openingName ?? data.eco}</h1>
      <p className="mt-2 text-sm text-neutral-400">{data.eco}</p>
    </header>
    <Link href={`/dashboard/games?${new URLSearchParams({ opening: data.eco, severity: "high" })}`} className="inline-flex rounded-lg border border-white/10 px-4 py-2 text-xs text-neutral-300 hover:bg-white/10">See high-severity games in this opening</Link>
    <OpeningDrilldownClient nodes={data.nodes} initialNode={initialNode} />
  </div>;
}
