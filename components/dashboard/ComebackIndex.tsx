import type { ComebackIndex as ComebackIndexData } from "@/lib/dashboard/getSignatureSignals";

export default function ComebackIndex({ data }: { data: ComebackIndexData }) {
  if (data.evaluatedWinCount === 0 || data.comebackWinCount === 0) return null;
  const pct = Math.round(data.comebackShare * 100);

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Comeback index</p>
      <h2 className="mt-2 text-lg font-medium">{pct}% of your evaluated wins were comebacks</h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        {data.comebackWinCount} of {data.evaluatedWinCount} evaluated wins recovered after falling to −2.0 pawns or facing a forced mate. Evaluation is available for {data.evaluatedWinCount} of {data.totalWinCount} wins; this is a personal statistic, not a rating-band comparison.
      </p>
    </section>
  );
}
