import BlindSpotHeatmap from "@/components/dashboard/BlindSpotHeatmap";
import type { BiasData } from "@/lib/bias/getBiasData";

// Included because this is real square-level move and flag statistics, not a cosmetic archetype label.
export default function PatternsSignature({ data }: { data: BiasData }) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-medium">Board signature</h2>
        <p className="mt-1 text-sm text-neutral-400">Square-level move and flag statistics from your evaluated games. Sparse samples stay neutral.</p>
      </div>
      <div className="rounded-xl bg-[#17161A] p-5 sm:p-6">
        <BlindSpotHeatmap data={data} />
      </div>
    </section>
  );
}
