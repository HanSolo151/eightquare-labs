import Link from "next/link";
import type { OpeningRow } from "@/lib/openings/getOpeningsData";

export default function PatternsByOpening({ openings }: { openings: OpeningRow[] }) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-medium">By opening</h2>
        <p className="mt-1 text-sm text-neutral-400">Relative danger combines recorded cp loss, loss rate, and flagged-move density across your openings. It describes this archive; it does not predict a result.</p>
      </div>
      {openings.length === 0 ? (
        <p className="rounded-xl bg-[#17161A] p-5 text-sm text-neutral-400">At least two saved games in an opening are needed before it can be compared.</p>
      ) : (
        <ol className="divide-y divide-white/10 rounded-xl bg-[#17161A] px-5">
          {openings.map((opening) => (
            <li key={opening.eco ?? opening.name} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
              <div className="min-w-56 flex-1">
                {opening.eco
                  ? <Link className="text-sm text-neutral-100 transition-colors duration-150 hover:text-white" href={`/dashboard/openings/${encodeURIComponent(opening.eco)}`}>{opening.name}</Link>
                  : <p className="text-sm text-neutral-100">{opening.name}</p>}
                <p className="mt-1 text-xs text-neutral-500">{opening.eco ?? "ECO unavailable"} · {opening.gamesPlayed} games</p>
              </div>
              <p className="text-xs text-neutral-400">{opening.avgCpLoss.toFixed(1)} cp loss per move</p>
              <p className="font-mono text-xs tabular-nums text-neutral-300">{Math.round(opening.lossRate * 100)}% losses</p>
              <p className="text-xs capitalize text-neutral-400">{opening.badge} relative danger</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
