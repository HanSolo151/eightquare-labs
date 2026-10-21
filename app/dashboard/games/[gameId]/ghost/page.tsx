import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getGhostMoment } from "@/lib/ghost/getGhostMoment";
import GhostReplay from "@/components/board/GhostReplay";

export const instant = false;

export default async function GhostReplayPage({ params, searchParams }: { params: Promise<{ gameId: string }>; searchParams: Promise<{ ply?: string }> }) {
  const [{ gameId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();
  // Absent means the game's worst flag. A supplied but invalid ply is a
  // bad target and must not silently fall back to a different position.
  let requestedPly: number | undefined;
  if (query.ply !== undefined) {
    if (!/^\d+$/.test(query.ply) || Number(query.ply) >= 600) notFound();
    requestedPly = Number.parseInt(query.ply, 10);
  }
  const moment = await getGhostMoment(userId, gameId, requestedPly);
  if (!moment) notFound();

  return <div className="space-y-6 pb-12">
    <Link href={`/dashboard/games/${encodeURIComponent(gameId)}`} className="inline-flex text-xs text-neutral-400 hover:text-white">← Back to game</Link>
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Ghost replay</p>
      <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">The moment it went wrong</h1>
      <p className="mt-2 text-sm text-neutral-400">Move {Math.floor(moment.ply / 2) + 1}, vs {moment.opponentUsername} · {Math.round(moment.cpLoss)} cp loss</p>
    </header>
    <GhostReplay key={`${moment.gameId}:${moment.ply}`} moment={moment} />
  </div>;
}
