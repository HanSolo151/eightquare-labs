import type { OpeningBreadth as OpeningBreadthData } from "@/lib/dashboard/getSignatureSignals";

export default function OpeningBreadth({ data }: { data: OpeningBreadthData }) {
  if (data.distinctEcoCount === 0) return null;

  return (
    <section className="border-y border-white/10 py-3">
      <p className="text-xs leading-5 text-neutral-400">
        You&apos;ve played <span className="text-white">{data.distinctEcoCount} distinct opening{data.distinctEcoCount === 1 ? "" : "s"}</span>
        {" "}across {data.gamesWithEco} games with a recorded ECO code
        {data.gamesWithoutEco > 0 ? ` (${data.gamesWithoutEco} games have no recorded opening)` : ""}.
      </p>
    </section>
  );
}
