import Link from "next/link";
import type { DashboardGamesData } from "@/lib/dashboard/getGamesData";
import type { OpeningRow } from "@/lib/openings/getOpeningsData";

export default function PatternsGameLog({ data, openings, selectedOpening, selectedSeverity }: {
  data: DashboardGamesData;
  openings: OpeningRow[];
  selectedOpening?: string;
  selectedSeverity?: "low" | "medium" | "high";
}) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-medium">Game log</h2>
        <p className="mt-1 text-sm text-neutral-400">Saved games and their persisted analysis. Newest games first.</p>
      </div>
      <form action="/dashboard/patterns" className="flex flex-wrap items-end gap-3 rounded-xl bg-[#17161A] p-4">
        <label className="grid gap-1 text-xs text-neutral-400">Opening
          <select name="opening" defaultValue={selectedOpening ?? ""} className="min-w-44 rounded-md border border-white/10 bg-[#0D0C0E] px-3 py-2 text-sm text-neutral-200">
            <option value="">All openings</option>
            {openings.filter((opening) => opening.eco).map((opening) => <option key={opening.eco} value={opening.eco!}>{opening.eco} · {opening.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-neutral-400">Severity
          <select name="severity" defaultValue={selectedSeverity ?? ""} className="min-w-36 rounded-md border border-white/10 bg-[#0D0C0E] px-3 py-2 text-sm text-neutral-200">
            <option value="">All severities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-white/10 px-4 py-2 text-sm text-neutral-200 transition-colors duration-150 hover:bg-white/15">Filter</button>
        {(selectedOpening || selectedSeverity) && <Link href="/dashboard/patterns" className="px-2 py-2 text-sm text-neutral-400 transition-colors duration-150 hover:text-white">Clear</Link>}
      </form>

      {data.games.length === 0 ? (
        <p className="rounded-xl bg-[#17161A] p-5 text-sm text-neutral-400">{data.totalGames === 0 ? "No saved games yet. Sync your Lichess archive to populate this log." : "No saved games match these filters."}</p>
      ) : (
        <div className="divide-y divide-white/10 rounded-xl bg-[#17161A] px-5">
          {data.games.map((game) => (
            <article key={game.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
              <div className="min-w-52 flex-1">
                <Link href={`/dashboard/games/${encodeURIComponent(game.id)}`} className="text-sm text-neutral-100 transition-colors duration-150 hover:text-white">vs {game.opponentUsername}</Link>
                <p className="mt-1 truncate text-xs text-neutral-500">{game.openingName ?? "Opening not recorded"} · {game.playerColor}</p>
              </div>
              <span className="font-mono text-xs tabular-nums text-neutral-400">{game.moveCount} ply</span>
              <span className="text-xs text-neutral-400">{game.evaluated ? `${game.flags.length} flags` : "Analysis pending"}</span>
              <span className="text-xs text-neutral-500">{game.createdAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(game.createdAt) : "Date unavailable"}</span>
            </article>
          ))}
        </div>
      )}

      {data.totalPages > 1 && <nav aria-label="Game log pages" className="flex items-center justify-between text-sm">
        {data.page > 1 ? <Link href={pageHref(data.page - 1, selectedOpening, selectedSeverity)} className="text-neutral-300 transition-colors duration-150 hover:text-white">Newer</Link> : <span className="text-neutral-700">Newer</span>}
        <span className="font-mono text-xs tabular-nums text-neutral-500">Page {data.page} of {data.totalPages}</span>
        {data.page < data.totalPages ? <Link href={pageHref(data.page + 1, selectedOpening, selectedSeverity)} className="text-neutral-300 transition-colors duration-150 hover:text-white">Older</Link> : <span className="text-neutral-700">Older</span>}
      </nav>}
    </section>
  );
}

function pageHref(page: number, opening?: string, severity?: string) {
  const params = new URLSearchParams({ page: String(page) });
  if (opening) params.set("opening", opening);
  if (severity) params.set("severity", severity);
  return `/dashboard/patterns?${params.toString()}`;
}
