import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import GameReplay from "@/components/board/GameReplay";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";
import { getAmbientPaceSignal } from "@/lib/pace/getAmbientPaceSignal";
import AmbientPaceSignal from "@/components/board/AmbientPaceSignal";
import type { EvalPoint } from "@/types";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

interface GamePageProps {
  params: Promise<{ gameId: string }>;
}

function readEvalPoints(value: unknown): EvalPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): EvalPoint[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const point = entry as Partial<EvalPoint>;
    const nullableNumber = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item));
    if (!Number.isInteger(point.ply) || !nullableNumber(point.cpBefore) || !nullableNumber(point.cpAfter)
      || !nullableNumber(point.mateBefore) || !nullableNumber(point.mateAfter) || typeof point.depth !== "number") return [];
    return [point as EvalPoint];
  });
}

type SavedGamePageProps = GamePageProps & { searchParams: Promise<{ ply?: string; spar?: string }> };

export default function SavedGamePage(props: SavedGamePageProps) {
  return <Suspense fallback={<DashboardPageFallback />}><SavedGamePageContent {...props} /></Suspense>;
}

async function SavedGamePageContent({ params, searchParams }: SavedGamePageProps) {
  const [{ gameId }, query, session] = await Promise.all([params, searchParams, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();

  // Scope the lookup to the authenticated owner. A guessed database id must
  // never expose another account's game.
  const game = await prisma.game.findFirst({
    where: { id: gameId, userId },
    include: { flags: { orderBy: { ply: "asc" } }, eval: { select: { points: true } } },
  });
  if (!game) notFound();
  const [effectiveRating, paceSignal, weaknessRow] = await Promise.all([
    getEffectiveRatingSignal(userId, game.opponentUsername),
    getAmbientPaceSignal(userId, gameId),
    prisma.weaknessProfileRow.findUnique({ where: { userId }, select: { patterns: true } }),
  ]);
  const moves = Array.isArray(game.moves)
    ? game.moves.filter((move): move is string => typeof move === "string")
    : [];
  const requestedPly = query.ply && /^\d+$/.test(query.ply) ? Number.parseInt(query.ply, 10) : 0;
  const initialPly = Number.isSafeInteger(requestedPly) && requestedPly <= moves.length ? requestedPly : 0;
  const patterns = Array.isArray(weaknessRow?.patterns) ? weaknessRow.patterns : [];
  const patternDescriptionById = new Map(patterns.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const pattern = entry as { id?: unknown; description?: unknown };
    return typeof pattern.id === "string" && typeof pattern.description === "string"
      ? [[pattern.id, pattern.description] as const]
      : [];
  }));
  const flags = game.flags.map((flag) => ({
    ply: flag.ply,
    san: flag.san,
    severity: flag.severity,
    flagType: flag.flagType,
    cpLoss: flag.cpLoss,
    explanation: flag.explanation,
    timeSpentSec: flag.timeSpentSec,
    phaseAvgSec: flag.phaseAvgSec,
    gamePhase: flag.gamePhase,
    patternDescription: flag.matchedWeaknessId ? patternDescriptionById.get(flag.matchedWeaknessId) ?? null : null,
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
        autoStartSpar={query.spar === "1"}
        moves={moves}
        flags={flags}
        evalPoints={readEvalPoints(game.eval?.points)}
        playerColor={game.playerColor === "black" ? "black" : "white"}
        maiaRating={game.opponentRating}
        humanRating={game.playerRating}
        opponentUsername={game.opponentUsername}
        effectiveRatingFires={effectiveRating.fires}
      />
    </div>
  );
}
