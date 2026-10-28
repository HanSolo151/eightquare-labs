import Link from "next/link";
import type { BiasData } from "@/lib/bias/getBiasData";

/** Highlights the busiest flagged destination square and links to its evidence. */
export default function NemesisSquare({ data }: { data: BiasData }) {
  if (!data.meetsThreshold) return null;

  const top = [...data.squares.blunderDensity]
    .sort((a, b) => b.flaggedCount - a.flaggedCount)[0];
  if (!top || top.flaggedCount < 3) return null;

  const totalFlags = data.squares.blunderDensity.reduce((sum, square) => sum + square.flaggedCount, 0);
  const share = totalFlags > 0 ? Math.round((top.flaggedCount / totalFlags) * 100) : 0;
  const gameCount = new Set(top.flaggedPositions.map((position) => position.gameId)).size;

  // Keep one replay link per game so repeated occurrences do not flood the card.
  const firstPositionByGame = new Map<string, { gameId: string; ply: number }>();
  for (const position of top.flaggedPositions) {
    if (!firstPositionByGame.has(position.gameId)) firstPositionByGame.set(position.gameId, position);
  }
  const evidence = [...firstPositionByGame.values()].slice(0, 6);

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-rose-300/80">Nemesis square</p>
      <h2 className="mt-2 text-lg font-medium">
        Your most flagged destination is <span className="font-mono text-rose-300">{top.square}</span>
      </h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        {top.flaggedCount} flagged moves across {gameCount} game{gameCount === 1 ? "" : "s"}
        {share > 0 ? ` · ${share}% of your flagged moves landed here` : ""}
        {top.avgCpLoss !== null ? `. Average recorded loss: ${Math.round(top.avgCpLoss)} cp.` : "."}
      </p>
      {evidence.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {evidence.map((position) => (
            <Link
              key={position.gameId}
              href={`/dashboard/games/${position.gameId}?ply=${position.ply}`}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300 hover:border-rose-300/30 hover:text-rose-200"
            >
              Replay · ply {position.ply}
            </Link>
          ))}
          {gameCount > evidence.length && (
            <Link href="/dashboard/games" className="rounded-full px-3 py-1 text-xs text-neutral-400 hover:text-white">
              All games · {gameCount} →
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
