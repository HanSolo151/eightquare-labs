import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getBiasData } from "@/lib/bias/getBiasData";
import BlindSpotHeatmap from "@/components/dashboard/BlindSpotHeatmap";

export const instant = false;

export default async function SignaturePage() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your signature.</p>;

  const data = await getBiasData(userId);
  return (
    <div className="space-y-6 pb-12">
      <header className="border-b border-white/10 pb-6">
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Identity layer / 02</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Blind Spot Heatmap</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">
          A descriptive view of where your flagged moves land and how clock pressure varies by square.
        </p>
      </header>
      <BlindSpotHeatmap data={data} />
    </div>
  );
}
