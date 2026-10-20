import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getRivalryDetail } from "@/lib/rivalries/getRivalryDetail";
import BlindSpotHeatmap from "@/components/dashboard/BlindSpotHeatmap";
import PositionSpar from "@/components/board/PositionSpar";

export const instant = false;

export default async function RivalryDetailPage({ params }: { params: Promise<{ opponentUsername: string }> }) {
  const [{ opponentUsername }, session] = await Promise.all([params, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();
  if (!/^[a-zA-Z0-9_-]{1,30}$/.test(opponentUsername)) notFound();
  const detail = await getRivalryDetail(userId, opponentUsername);
  if (!detail) notFound();

  return <div className="space-y-6 pb-12">
    <Link href="/dashboard/rivalries" className="inline-flex text-xs text-neutral-400 hover:text-white">← Back to rivalries</Link>
    <header className="border-b border-white/10 pb-6">
      <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">vs {detail.opponentUsername}</h1>
      <p className="mt-2 text-sm text-neutral-400">{detail.wins}W {detail.losses}L {detail.draws}D · current streak: {detail.streak?.count ?? 0} {detail.streak?.result ?? "games"}</p>
    </header>
    <section className="rounded-xl border border-white/10 bg-black/35 p-5">
      <p className="text-xs uppercase tracking-widest text-neutral-500">Repeated flagged-move locations</p>
      <p className="mb-4 mt-1 text-xs text-neutral-500">This is a destination distribution of persisted flagged moves, not a blunder rate. Unflagged moves and per-move clock data are not retained per opponent.</p>
      <BlindSpotHeatmap data={detail.heatmap} />
    </section>
    <section className="rounded-xl border border-white/10 bg-black/35 p-5">
      <p className="text-xs uppercase tracking-widest text-neutral-500">Openings against this opponent</p>
      {detail.openings.length === 0 ? <p className="mt-3 text-xs text-neutral-500">No qualifying openings yet.</p> : (
        <ol className="mt-4 divide-y divide-white/10">
          {detail.openings.map((opening) => <li key={opening.eco ?? opening.name} className="flex justify-between gap-4 py-3 text-sm text-neutral-200"><span>{opening.name}</span><span className="shrink-0 text-neutral-400">{opening.badge} · {opening.gamesPlayed} games</span></li>)}
        </ol>
      )}
    </section>
    {detail.effectiveRatingFires && <p className="text-xs text-violet-200/70">Matchup history has enough rated games to inform opponent-specific spar.</p>}
    {detail.dangerMove && <section className="rounded-xl border border-white/10 bg-black/35 p-5">
      <p className="text-xs uppercase tracking-widest text-neutral-500">Drill the worst flagged position</p>
      <div className="mt-4 max-w-[420px]">
        <PositionSpar fen={detail.dangerMove.fen} humanColor={detail.dangerMove.playerColor} maiaRating={detail.dangerMove.maiaRating} humanRating={detail.dangerMove.humanRating} opponentUsername={detail.dangerMove.opponentUsername} effectiveRatingFires={detail.effectiveRatingFires} />
      </div>
    </section>}
  </div>;
}
