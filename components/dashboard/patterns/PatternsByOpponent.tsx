import Link from "next/link";
import type { RivalryCard } from "@/lib/rivalries/getRivalriesList";

export default function PatternsByOpponent({ rivalries }: { rivalries: RivalryCard[] }) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-medium">By opponent</h2>
        <p className="mt-1 text-sm text-neutral-400">Opponents you have lost to more than once, based on your saved games.</p>
      </div>
      {rivalries.length === 0 ? (
        <p className="rounded-xl bg-[#17161A] p-5 text-sm text-neutral-400">No repeated losses to one opponent in the saved game history yet.</p>
      ) : (
        <ul className="divide-y divide-white/10 rounded-xl bg-[#17161A] px-5">
          {rivalries.map((rival) => (
            <li key={rival.opponentUsername}>
              <Link href={`/dashboard/rivalries/${encodeURIComponent(rival.opponentUsername)}`} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-4 transition-colors duration-150 hover:text-white">
                <span className="min-w-36 text-sm text-neutral-100">{rival.opponentUsername}</span>
                <span className="font-mono text-xs tabular-nums text-neutral-300">{rival.wins}W {rival.losses}L {rival.draws}D</span>
                <span className="text-sm text-neutral-400">{rival.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
