import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import GameReplay from "@/components/board/GameReplay";

interface GamePageProps {
  params: Promise<{ gameId: string }>;
}

export const instant = false;

export default async function SavedGamePage({ params }: GamePageProps) {
  const [{ gameId }, session] = await Promise.all([params, auth()]);
  const userId = getSessionUserId(session);
  if (!userId) notFound();

  // Scope the lookup to the authenticated owner. A guessed database id must
  // never expose another account's game.
  const game = await prisma.game.findFirst({
    where: { id: gameId, userId },
    include: { flags: { orderBy: { ply: "asc" } } },
  });
  if (!game) notFound();

  const moves = Array.isArray(game.moves)
    ? game.moves.filter((move): move is string => typeof move === "string")
    : [];
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
        <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Saved game review</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">vs {game.opponentUsername}</h1>
        <p className="mt-2 text-sm text-neutral-400">
          {game.openingName ?? "Opening unavailable"}{game.openingEco ? ` · ${game.openingEco}` : ""}
          {game.lichessCreatedAt ? ` · ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(game.lichessCreatedAt)}` : ""}
          {` · ${game.playerColor} · ${game.result}`}
        </p>
      </header>
      <GameReplay
        moves={moves}
        flags={flags}
        playerColor={game.playerColor === "black" ? "black" : "white"}
        maiaRating={game.opponentRating}
        humanRating={game.playerRating}
        opponentUsername={game.opponentUsername}
      />
    </div>
  );
}
