import Link from "next/link";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getGamesData } from "@/lib/dashboard/getGamesData";

export const instant = false;

const severityFill: Record<string, string> = {
  high: "bg-rose-400",
  medium: "bg-amber-300",
  low: "bg-sky-300",
};

function resultLabel(result: string) {
  if (result === "win") return "Win";
  if (result === "loss") return "Loss";
  return "Draw";
}

interface GamesPageProps {
  searchParams: Promise<{ page?: string | string[] }>;
}

export default async function GamesPage({ searchParams }: GamesPageProps) {
  const [{ page: rawPage }, session] = await Promise.all([searchParams, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) return <EmptyState title="Session unavailable" detail="Sign in again to view your saved games." />;

  const pageValue = Array.isArray(rawPage) ? rawPage[0] : rawPage;
  const requestedPage = pageValue && /^\d+$/.test(pageValue) ? Number.parseInt(pageValue, 10) : 1;
  const data = await getGamesData(userId, requestedPage);
  const first = data.totalGames === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.page * data.pageSize, data.totalGames);

  return (
    <div className="space-y-7 pb-12">
      <header className="flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Game archive / 02</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Games</h1>
          <p className="mt-2 text-sm text-neutral-400">Saved games and persisted analysis, newest first.</p>
        </div>
        <p className="text-xs tabular-nums text-neutral-400">{data.evaluatedGames.toLocaleString()} / {data.totalGames.toLocaleString()} evaluated</p>
      </header>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-4 py-3 text-xs text-neutral-400">
        <span>Showing <span className="text-white">{first}–{last}</span> of <span className="text-white">{data.totalGames}</span> saved games</span>
        <span>Timeline marks stored flags by move · review games on this platform</span>
      </section>

      {data.games.length === 0 ? (
        <EmptyState title="No saved games yet" detail="Run a Lichess sync from the Signature screen. Games appear here after they are stored in your account archive." />
      ) : (
        <div className="space-y-3">
          {data.games.map((game) => {
            const flagByPly = new Map(game.flags.map((flag) => [flag.ply, flag]));
            return <article key={game.id} className="rounded-xl border border-white/10 bg-black/35 p-4 sm:p-5">
              <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wider ${game.result === "win" ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : game.result === "loss" ? "border-rose-300/20 bg-rose-300/10 text-rose-200" : "border-white/10 text-neutral-300"}`}>{resultLabel(game.result)}</span>
                    <h2 className="text-sm font-medium">vs {game.opponentUsername}{game.opponentRating ? <span className="ml-1 font-normal text-neutral-500">({game.opponentRating})</span> : null}</h2>
                    <span className="text-xs capitalize text-neutral-500">{game.playerColor} · {game.speed ?? "chess"}{game.rated ? " · rated" : " · casual"}</span>
                  </div>
                  <p className="mt-2 truncate text-xs text-neutral-300">{game.openingName ?? "Opening not recorded"}{game.openingEco ? <span className="ml-2 text-neutral-500">{game.openingEco}</span> : null}</p>
                  <p className="mt-1 text-[11px] text-neutral-500">{game.createdAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(game.createdAt) : "Date unavailable"} · {Math.ceil(game.moveCount / 2)} moves · {game.playerRating ? `your rating ${game.playerRating}` : "your rating unavailable"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-start">
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] ${game.evaluated ? "border-emerald-300/20 text-emerald-200" : "border-white/10 text-neutral-500"}`}>{game.evaluated ? "evaluated" : "pending eval"}</span>
                  <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-neutral-400">{game.flags.length} flag{game.flags.length === 1 ? "" : "s"}</span>
                  <Link href={`/dashboard/games/${encodeURIComponent(game.id)}`} className="rounded border border-white/10 px-2.5 py-1 text-[10px] text-neutral-300 hover:border-emerald-300/40 hover:text-white">Review →</Link>
                </div>
              </div>

              <div className="mt-5">
                {game.moveCount > 0 ? <div className="flex h-3 gap-px overflow-hidden rounded-sm" role="img" aria-label={`${game.moveCount} half-moves; ${game.flags.length} flagged positions`}>
                  {Array.from({ length: game.moveCount }, (_, ply) => {
                    const flag = flagByPly.get(ply);
                    const description = flag ? `Move ${Math.floor(ply / 2) + 1}, ${flag.san}, ${flag.severity} ${flag.flagType}, ${Math.round(flag.cpLoss)} centipawn loss` : `Move ${Math.floor(ply / 2) + 1}, no stored flag`;
                    return <span key={ply} title={description} aria-label={description} className={`min-w-[2px] flex-1 ${flag ? severityFill[flag.severity] ?? "bg-violet-300" : ply % 2 === 0 ? "bg-white/15" : "bg-white/8"}`} />;
                  })}
                </div> : <p className="text-xs text-neutral-600">No move list saved.</p>}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500">
                  <span><i className="mr-1.5 inline-block size-2 rounded-full bg-rose-400" />high severity</span>
                  <span><i className="mr-1.5 inline-block size-2 rounded-full bg-amber-300" />medium</span>
                  <span><i className="mr-1.5 inline-block size-2 rounded-full bg-sky-300" />low</span>
                  <span className="ml-auto">{game.flags.length ? `${game.flags.length} saved analysis flag${game.flags.length === 1 ? "" : "s"}` : "No saved flags"}</span>
                </div>
              </div>
            </article>;
          })}
        </div>
      )}

      {data.totalPages > 1 && <nav aria-label="Game pages" className="flex items-center justify-between border-t border-white/10 pt-4 text-sm">
        {data.page > 1 ? <Link href={`/dashboard/games?page=${data.page - 1}`} className="text-neutral-300 hover:text-white">← Newer</Link> : <span className="text-neutral-700">← Newer</span>}
        <span className="text-xs tabular-nums text-neutral-500">Page {data.page} / {data.totalPages}</span>
        {data.page < data.totalPages ? <Link href={`/dashboard/games?page=${data.page + 1}`} className="text-neutral-300 hover:text-white">Older →</Link> : <span className="text-neutral-700">Older →</span>}
      </nav>}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className="rounded-xl border border-dashed border-white/15 bg-black/30 px-6 py-12 text-center"><p className="text-lg">{title}</p><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-neutral-500">{detail}</p></section>;
}
