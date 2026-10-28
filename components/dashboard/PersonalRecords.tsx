import Link from "next/link";
import type { PersonalRecords as PersonalRecordsData } from "@/lib/dashboard/getSignatureSignals";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export default function PersonalRecords({ records }: { records: PersonalRecordsData }) {
  const { biggestComeback, longestWin, bestWinVsHigherRated } = records;
  if (!biggestComeback && !longestWin && !bestWinVsHigherRated) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Personal records</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {biggestComeback && (
          <Link
            href={`/dashboard/games/${biggestComeback.gameId}?ply=${biggestComeback.ply}`}
            className="rounded-lg border border-white/10 bg-white/5 p-4 hover:border-emerald-300/30"
          >
            <p className="text-xs text-neutral-400">Biggest recorded comeback</p>
            <p className="mt-1 text-sm text-neutral-200">
              {biggestComeback.forcedMateAgainstPlayerIn !== null
                ? `Won after facing forced mate in ${biggestComeback.forcedMateAgainstPlayerIn}`
                : `Won after an engine evaluation put you about ${(Math.abs(biggestComeback.worstCpForPlayer ?? 0) / 100).toFixed(1)} pawns behind`}
              {` vs ${biggestComeback.opponentUsername}`}
            </p>
            {formatDate(biggestComeback.playedAt) && (
              <p className="mt-1 text-[11px] text-neutral-500">{formatDate(biggestComeback.playedAt)}</p>
            )}
          </Link>
        )}
        {longestWin && (
          <Link
            href={`/dashboard/games/${longestWin.gameId}`}
            className="rounded-lg border border-white/10 bg-white/5 p-4 hover:border-emerald-300/30"
          >
            <p className="text-xs text-neutral-400">Longest win</p>
            <p className="mt-1 text-sm text-neutral-200">
              {Math.ceil(longestWin.plyCount / 2)} moves vs {longestWin.opponentUsername}
            </p>
            {formatDate(longestWin.playedAt) && (
              <p className="mt-1 text-[11px] text-neutral-500">{formatDate(longestWin.playedAt)}</p>
            )}
          </Link>
        )}
        {bestWinVsHigherRated && (
          <Link
            href={`/dashboard/games/${bestWinVsHigherRated.gameId}`}
            className="rounded-lg border border-white/10 bg-white/5 p-4 hover:border-emerald-300/30"
          >
            <p className="text-xs text-neutral-400">Best win vs. higher rated</p>
            <p className="mt-1 text-sm text-neutral-200">
              Beat {bestWinVsHigherRated.opponentUsername} ({bestWinVsHigherRated.opponentRating})
              <span className="ml-1 text-emerald-200">+{bestWinVsHigherRated.ratingGap} rating gap</span>
            </p>
            {formatDate(bestWinVsHigherRated.playedAt) && (
              <p className="mt-1 text-[11px] text-neutral-500">{formatDate(bestWinVsHigherRated.playedAt)}</p>
            )}
          </Link>
        )}
      </div>
      {biggestComeback && (
        <p className="mt-3 text-[10px] leading-5 text-neutral-600">
          Comeback estimate uses saved Stockfish evaluations at depth 10 or higher; it is an engine estimate, not a measured material count.
        </p>
      )}
    </section>
  );
}
