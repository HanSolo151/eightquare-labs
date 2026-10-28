import type { OpeningBreadth as OpeningBreadthData } from "@/lib/dashboard/getSignatureSignals";

export default function OpeningBreadth({ data }: { data: OpeningBreadthData }) {
  if (data.distinctEcoCount === 0) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-sky-300/80">Opening breadth</p>
      <h2 className="mt-2 text-lg font-medium">
        You&apos;ve played {data.distinctEcoCount} distinct opening{data.distinctEcoCount === 1 ? "" : "s"}
      </h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        Across {data.gamesWithEco} games with a recorded ECO code
        {data.gamesWithoutEco > 0 ? ` (${data.gamesWithoutEco} games have no recorded opening)` : ""}.
      </p>
    </section>
  );
}
