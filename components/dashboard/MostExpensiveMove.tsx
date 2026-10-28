import Link from "next/link";
import type { MostExpensiveMove as MostExpensiveMoveData } from "@/lib/dashboard/getSignatureSignals";

export default function MostExpensiveMove({ move }: { move: MostExpensiveMoveData | null }) {
  if (!move) return null;

  const date = move.playedAt
    ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(move.playedAt))
    : null;

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-amber-300/80">Largest recorded evaluation drop</p>
      <h2 className="mt-2 text-lg font-medium">
        {date ? `${date} · ` : ""}vs {move.opponentUsername}, move {move.moveNumber}
      </h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        <span className="font-mono text-amber-300">{move.san}</span> was followed by a {Math.round(move.cpLoss)} cp drop — the largest recorded in your evaluated games.
      </p>
      <Link
        href={`/dashboard/games/${move.gameId}?ply=${move.ply}`}
        className="mt-4 inline-block rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300 hover:border-amber-300/30 hover:text-amber-200"
      >
        Replay this move →
      </Link>
    </section>
  );
}
