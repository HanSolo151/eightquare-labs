import Link from "next/link";
import { notFound } from "next/navigation";
import { Chess } from "chess.js";
import ChessgroundBoard from "@/components/board/ChessgroundBoard";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const instant = false;

function representativeSamplePosition(pgn: string, phase: string): { fen: string; move: string } | null {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    const sampleIndex = phase === "opening" ? 8 : phase === "middlegame" ? 24 : 40;
    const target = Math.min(sampleIndex, history.length - 1);
    if (target < 0) return null;
    const replay = new Chess();
    for (let index = 0; index < target; index++) replay.move(history[index]!);
    return { fen: replay.fen(), move: history[target]!.san };
  } catch {
    return null;
  }
}

export default async function PlayerStyleMatchPage({ params }: { params: Promise<{ momentId: string }> }) {
  const [{ momentId }, session] = await Promise.all([params, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();
  const moment = await prisma.gameMoment.findFirst({
    where: { id: momentId, userId, matchedBigshotId: { not: null }, sampleGameId: { not: null } },
    include: {
      game: { select: { opponentUsername: true, playerColor: true } },
      matchedBigshot: { select: { name: true } },
    },
  });
  if (!moment?.matchedBigshot || !moment.sampleGameId) notFound();
  const sample = await prisma.bigshotSampleGame.findUnique({ where: { id: moment.sampleGameId } });
  if (!sample) notFound();
  const representative = representativeSamplePosition(sample.pgn, moment.phase);

  return <div className="space-y-6 pb-12">
    <Link href={`/dashboard/games/${encodeURIComponent(moment.gameId)}/ghost?ply=${moment.ply}`} className="text-sm text-neutral-400 hover:text-white">← Back to this game position</Link>
    <header className="border-b border-white/10 pb-5">
      <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Player-style match</p>
      <h1 className="mt-3 text-3xl font-semibold">Your game, compared with {moment.matchedBigshot.name}</h1>
      <p className="mt-2 text-sm text-neutral-400">A style-vector match from your analyzed {moment.game.opponentUsername} game. The boards compare positions from the same game phase; this is a stylistic similarity, not a claim that the moves are identical.</p>
    </header>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <h2 className="font-semibold">Your position · {moment.phase}</h2>
        <ChessgroundBoard fen={moment.fenBeforeMove} orientation={moment.game.playerColor === "black" ? "black" : "white"} />
        <p className="text-sm text-neutral-300">Move {moment.moveNumber}: {moment.san} vs {moment.game.opponentUsername}</p>
        <p className="text-xs text-neutral-500">{moment.soundness === "unverified" ? "Move quality could not be verified from the saved evaluation." : moment.soundness === "sound" ? "The move passed the saved evaluation soundness check." : "The position resembles this player’s style; the move’s evaluation worsened."}</p>
      </section>
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <h2 className="font-semibold">{moment.matchedBigshot.name} · representative {moment.phase} position</h2>
        {representative ? <>
          <ChessgroundBoard fen={representative.fen} orientation="white" />
          <p className="text-sm text-neutral-300">Next move in the source game: {representative.move}</p>
        </> : <p className="aspect-square content-center text-sm text-neutral-500">The stored sample game could not be replayed.</p>}
        {sample.attribution && <p className="text-xs text-neutral-400">{sample.attribution}</p>}
        <p className="text-xs text-neutral-500">Source: {sample.sourceRef}</p>
      </section>
    </div>
    <p className="text-xs text-neutral-500">Similarity distance: {moment.matchDistance?.toFixed(3) ?? "unavailable"}. Matches are generated from phase-level features and are exploratory, not a measure of playing strength.</p>
  </div>;
}
