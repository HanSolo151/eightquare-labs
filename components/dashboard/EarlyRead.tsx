type ObservedFlag = {
  gameId: string;
  phase: string | null;
  cpLoss: number;
};

const PHASE_ORDER = ["opening", "middlegame", "endgame"] as const;

/** Summarizes evidence already present without presenting one-off signals as stable traits. */
export default function EarlyRead({ flags, evaluatedGames, totalGames }: {
  flags: ObservedFlag[];
  evaluatedGames: number;
  totalGames: number;
}) {
  const phaseRows = PHASE_ORDER.map((phase) => {
    const rows = flags.filter((flag) => flag.phase === phase && Number.isFinite(flag.cpLoss));
    const avgCp = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.cpLoss, 0) / rows.length) : 0;
    return { phase, rows, avgCp, gameCount: new Set(rows.map((row) => row.gameId)).size };
  }).filter((row) => row.rows.length > 0).sort((a, b) => b.avgCp - a.avgCp);
  const leading = phaseRows[0];
  const recurring = leading ? leading.gameCount >= 3 : false;

  return <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Early read · from saved analysis</p>
        <h2 className="mt-2 text-lg font-medium">Signals to watch</h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">A useful first read from evaluated games. These are engine flagged evaluation drops, not a complete measure of how well you played.</p>
      </div>
      <span className={`rounded-full border px-3 py-1 text-xs ${recurring ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-200" : "border-amber-300/25 bg-amber-300/10 text-amber-100"}`}>
        {recurring ? "Seen across games" : "Early signal"}
      </span>
    </div>

    {leading ? <>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <article className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">Largest average flagged drop</p>
          <p className="mt-2 text-xl font-medium capitalize">{leading.phase}</p>
          <p className="mt-1 text-xs text-neutral-400">{leading.avgCp} cp across {leading.rows.length} flagged {leading.rows.length === 1 ? "move" : "moves"}</p>
        </article>
        <article className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">Coverage</p>
          <p className="mt-2 text-xl font-medium">{evaluatedGames} <span className="text-sm font-normal text-neutral-400">/ {totalGames}</span></p>
          <p className="mt-1 text-xs text-neutral-400">games evaluated / synced</p>
        </article>
        <article className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">Evidence spread</p>
          <p className="mt-2 text-xl font-medium">{leading.gameCount} {leading.gameCount === 1 ? "game" : "games"}</p>
          <p className="mt-1 text-xs text-neutral-400">with a flagged drop in this phase</p>
        </article>
      </div>
      <p className="mt-4 text-xs leading-5 text-neutral-500">
        {recurring
          ? `This phase has appeared in ${leading.gameCount} different games. Treat it as a recurring area to review, not a complete verdict on your play.`
          : `So far this is based on ${leading.gameCount} ${leading.gameCount === 1 ? "game" : "games"}. More evaluated games may change which phase stands out.`}
      </p>
      {phaseRows.length > 1 && <ul className="mt-4 divide-y divide-white/10 border-t border-white/10">
        {phaseRows.slice(1).map((row) => <li key={row.phase} className="flex items-center justify-between gap-4 py-3 text-xs">
          <span className="capitalize text-neutral-300">{row.phase}</span>
          <span className="text-neutral-500">{row.avgCp} cp average · {row.rows.length} flagged {row.rows.length === 1 ? "move" : "moves"} in {row.gameCount} {row.gameCount === 1 ? "game" : "games"}</span>
        </li>)}
      </ul>}
    </> : <p className="mt-5 rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs leading-5 text-neutral-500">
      {evaluatedGames > 0
        ? `${evaluatedGames} ${evaluatedGames === 1 ? "game has" : "games have"} been evaluated, but no significant flagged drops are stored. That is a positive result; it does not mean there is no room to improve.`
        : totalGames > 0
          ? `${totalGames} games are synced. Their evaluations are still needed before phase level signals can be summarized.`
          : "Sync a game and let its evaluation finish to build your first evidence based read."}
    </p>}
  </section>;
}
