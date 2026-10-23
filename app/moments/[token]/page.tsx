import Link from "next/link";
import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import ChessgroundBoard from "@/components/board/ChessgroundBoard";
import { MatchFeedback } from "@/components/matching/MatchFeedback";
import { prisma } from "@/lib/prisma";

export const instant = false;

function samplePosition(pgn: string, phase: string): { fen: string; san: string } | null {
  try {
    const source = new Chess(); source.loadPgn(pgn);
    const moves = source.history({ verbose: true });
    const at = Math.min(phase === "opening" ? 8 : phase === "middlegame" ? 24 : 40, moves.length - 1);
    if (at < 0) return null;
    const position = new Chess();
    for (let index = 0; index < at; index++) position.move(moves[index]!);
    return { fen: position.fen(), san: moves[at]!.san };
  } catch { return null; }
}

export default async function SharedPlayerMatchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const hash = createHash("sha256").update(token).digest("hex");
  const moment = await prisma.gameMoment.findFirst({
    where: { deepLinkTokenHash: hash, deepLinkExpiresAt: { gt: new Date() }, status: "emailed" },
    include: { game: { select: { opponentUsername: true, playerColor: true } }, matchedBigshot: { select: { name: true } } },
  });
  if (!moment?.matchedBigshot || !moment.sampleGameId) return <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-white/10 p-6">
    <p className="text-xs uppercase tracking-[0.25em] text-amber-300">Match link unavailable</p>
    <h1 className="text-2xl font-semibold">This comparison link has expired or is invalid.</h1>
    <p className="text-sm text-neutral-400">Sign in to review your saved games, or return to the dashboard to keep exploring your analysis.</p>
    <div className="flex gap-4 text-sm"><Link href="/login" className="text-emerald-200 hover:text-white">Sign in</Link><Link href="/dashboard" className="text-neutral-300 hover:text-white">Dashboard</Link></div>
  </div>;
  const sample = await prisma.bigshotSampleGame.findUnique({ where: { id: moment.sampleGameId } });
  if (!sample) return <div className="rounded-xl border border-white/10 p-6"><h1 className="text-xl font-semibold">Comparison unavailable</h1><p className="mt-2 text-sm text-neutral-400">The sample game for this match is no longer available. You can still review your saved game in the dashboard.</p><Link href="/dashboard" className="mt-4 inline-block text-sm text-emerald-200">Open dashboard</Link></div>;
  const representative = samplePosition(sample.pgn, moment.phase);
  const boardOrientation = moment.game.playerColor === "black" ? "black" : "white";

  return <div className="mx-auto max-w-6xl space-y-6 pb-12">
    <header className="border-b border-white/10 pb-5">
      <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Player-style match</p>
      <h1 className="mt-3 text-3xl font-semibold">Your game compared with {moment.matchedBigshot.name}</h1>
      <p className="mt-2 max-w-3xl text-sm text-neutral-400">These positions come from the same phase of each game. This is a style-vector similarity, not a claim that the moves are identical or that one player has the same strength.</p>
    </header>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <h2 className="font-semibold">Your position · {moment.phase}</h2>
        <ChessgroundBoard fen={moment.fenBeforeMove} orientation={boardOrientation} />
        <p className="text-sm text-neutral-300">Move {moment.moveNumber}: {moment.san} vs {moment.game.opponentUsername}</p>
        <p className="text-xs text-neutral-500">{moment.soundness === "sound" ? "The move passed the saved evaluation soundness check." : moment.soundness === "unsound_lucky" ? "The move worsened the saved evaluation, even though the game was won." : "Move quality could not be verified from the saved evaluation."}</p>
      </section>
      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <h2 className="font-semibold">{moment.matchedBigshot.name} · representative {moment.phase} position</h2>
        {representative ? <><ChessgroundBoard fen={representative.fen} orientation="white" /><p className="text-sm text-neutral-300">Next move in the source game: {representative.san}</p></> : <p className="aspect-square content-center text-sm text-neutral-500">The source game could not be replayed.</p>}
        {sample.attribution && <p className="text-xs text-neutral-400">{sample.attribution}</p>}
        <p className="text-xs text-neutral-500">Source: {sample.sourceRef}</p>
      </section>
    </div>
    <p className="text-xs text-neutral-500">Similarity distance: {moment.matchDistance?.toFixed(3) ?? "unavailable"}.</p>
    <MatchFeedback token={token} initial={moment.feedback} />
    <Link href="/dashboard" className="text-sm text-neutral-400 hover:text-white">Open your dashboard</Link>
  </div>;
}
