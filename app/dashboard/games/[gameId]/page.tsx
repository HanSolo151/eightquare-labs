import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import GameReplay from "@/components/board/GameReplay";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";
import { getAmbientPaceSignal } from "@/lib/pace/getAmbientPaceSignal";
import AmbientPaceSignal from "@/components/board/AmbientPaceSignal";
import { Chess } from "chess.js";

interface GamePageProps {
  params: Promise<{ gameId: string }>;
}

export const instant = false;

export default async function SavedGamePage({ params, searchParams }: GamePageProps & { searchParams: Promise<{ ply?: string }> }) {
  const [{ gameId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();

  // Scope the lookup to the authenticated owner. A guessed database id must
  // never expose another account's game.
  const game = await prisma.game.findFirst({
    where: { id: gameId, userId },
    include: { flags: { orderBy: { ply: "asc" } } },
  });
  if (!game) notFound();
  const [effectiveRating, paceSignal] = await Promise.all([
    getEffectiveRatingSignal(userId, game.opponentUsername),
    getAmbientPaceSignal(userId, gameId),
  ]);
  const [matches, evaluationJob] = await Promise.all([
    prisma.gameMoment.findMany({
      where: { userId, gameId, status: { in: ["matched", "queued", "emailed"] }, matchedBigshotId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { phase: true, moveNumber: true, soundness: true, matchDistance: true, sampleGameId: true, matchedBigshot: { select: { name: true } } },
    }),
    prisma.vanityEvaluationJob.findUnique({ where: { gameId }, select: { status: true } }),
  ]);
  const sampleIds = [...new Set(matches.flatMap((match) => match.sampleGameId ? [match.sampleGameId] : []))];
  const sampleGames = sampleIds.length
    ? await prisma.bigshotSampleGame.findMany({ where: { id: { in: sampleIds } }, select: { id: true, pgn: true } })
    : [];
  const referenceById = new Map(sampleGames.map((sample) => {
    let label = "representative game";
    try {
      const chess = new Chess();
      chess.loadPgn(sample.pgn);
      const headers = chess.getHeaders();
      const players = [headers.White, headers.Black].filter((value) => value && value !== "?").join(" vs ");
      const event = headers.Event && headers.Event !== "?" ? headers.Event : "reference game";
      const year = headers.Date && /^\d{4}/.test(headers.Date) ? headers.Date.slice(0, 4) : null;
      label = [event, year, players || null].filter(Boolean).join(" · ");
    } catch { /* Use the generic label for an invalid stored sample PGN. */ }
    return [sample.id, label] as const;
  }));
  const orderedMatches = [...matches].sort((a, b) => ["opening", "middlegame", "endgame"].indexOf(a.phase) - ["opening", "middlegame", "endgame"].indexOf(b.phase));

  const moves = Array.isArray(game.moves)
    ? game.moves.filter((move): move is string => typeof move === "string")
    : [];
  const requestedPly = query.ply && /^\d+$/.test(query.ply) ? Number.parseInt(query.ply, 10) : 0;
  const initialPly = Number.isSafeInteger(requestedPly) && requestedPly <= moves.length ? requestedPly : 0;
  const flags = game.flags.map((flag) => ({
    ply: flag.ply,
    san: flag.san,
    severity: flag.severity,
    flagType: flag.flagType,
    cpLoss: flag.cpLoss,
    explanation: flag.explanation,
  }));

  return (
    <div className="space-y-6 pb-12">
      <Link href="/dashboard/games" className="inline-flex text-xs text-neutral-400 hover:text-white">← Back to games</Link>
      <header className="border-b border-white/10 pb-6">
        {paceSignal && <div className="mb-3"><AmbientPaceSignal signal={paceSignal} /></div>}
        {game.flags.length > 0 && <Link href={`/dashboard/games/${encodeURIComponent(gameId)}/ghost`} className="mb-3 inline-flex text-xs text-amber-300 hover:text-amber-200">See the moment it went wrong →</Link>}
        <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Saved game review</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">vs {game.opponentUsername}</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {game.openingName ?? "Opening unavailable"}{game.openingEco ? ` · ${game.openingEco}` : ""}
          {game.lichessCreatedAt && <> · <time dateTime={game.lichessCreatedAt.toISOString()} suppressHydrationWarning>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(game.lichessCreatedAt)}</time></>}
          {` · ${game.playerColor} · ${game.result}`}
        </p>
      </header>
      <GameReplay
        key={`${gameId}:${initialPly}`}
        gameId={gameId}
        initialPly={initialPly}
        moves={moves}
        flags={flags}
        playerColor={game.playerColor === "black" ? "black" : "white"}
        maiaRating={game.opponentRating}
        humanRating={game.playerRating}
        opponentUsername={game.opponentUsername}
        effectiveRatingFires={effectiveRating.fires}
        styleMatches={orderedMatches.map((match) => ({
          bigshotName: match.matchedBigshot?.name ?? "Unknown player",
          phase: match.phase,
          moveNumber: match.moveNumber,
          soundness: match.soundness,
          distance: match.matchDistance,
          referenceGame: match.sampleGameId ? referenceById.get(match.sampleGameId) ?? "representative game" : "representative game",
        }))}
        styleMatchStatus={{
          evaluationStatus: evaluationJob?.status ?? null,
          eligible: game.rated && game.result === "win",
        }}
      />
    </div>
  );
}
