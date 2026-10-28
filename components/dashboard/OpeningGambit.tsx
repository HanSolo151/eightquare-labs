import Link from "next/link";
import type { OpeningRow } from "@/lib/openings/getOpeningsData";

/**
 * Positive counterpart to the danger-score list: the opening where the
 * player's own results hold up best against their other openings. dangerScore
 * is normalized within this account, so this card makes no population claim.
 */
export default function OpeningGambit({ openings }: { openings: OpeningRow[] }) {
  const eligible = openings.filter((opening) => opening.badge === "safe" && opening.gamesPlayed >= 2);
  if (eligible.length === 0) return null;

  const best = [...eligible].sort((a, b) => b.winRate - a.winRate)[0];
  const winPct = Math.round(best.winRate * 100);

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-sky-300/80">Opening gambit</p>
      <h2 className="mt-2 text-lg font-medium">{best.name} is your strongest opening</h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        {winPct}% win rate across {best.gamesPlayed} games — your safest opening relative to the rest of your own repertoire.
      </p>
      {best.eco && (
        <Link
          href={`/dashboard/openings/${encodeURIComponent(best.eco)}`}
          className="mt-4 inline-block rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300 hover:border-sky-300/30 hover:text-sky-200"
        >
          See the games
        </Link>
      )}
    </section>
  );
}
