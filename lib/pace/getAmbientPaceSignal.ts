import { prisma } from "@/lib/prisma";

const MIN_PRIOR_OCCURRENCES = 2;

export interface AmbientPaceSignal {
  startMove: number;
  endMove: number;
  priorOccurrences: number;
}

/** Retrospective only: reports a recurring cascade-decline pattern in the
 * same opening and phase. It does not predict future play or assert that
 * every move in the cascade was below the player's usual pace. */
export async function getAmbientPaceSignal(
  userId: string,
  gameId: string
): Promise<AmbientPaceSignal | null> {
  const game = await prisma.game.findFirst({
    where: { id: gameId, userId },
    select: {
      openingName: true,
      lichessCreatedAt: true,
      flags: {
        where: { flagType: "tilt_cascade" },
        orderBy: { cpLoss: "desc" },
        take: 1,
        select: { ply: true, gamePhase: true, cascadeMeta: true },
      },
    },
  });
  const cascade = game?.flags[0];
  if (!game?.openingName || !game.lichessCreatedAt || !cascade) return null;

  const meta: unknown = cascade.cascadeMeta;
  if (!meta || typeof meta !== "object") return null;
  const { startPly, sequenceLength } = meta as Record<string, unknown>;
  if (
    !Number.isInteger(startPly) || (startPly as number) < 0 ||
    !Number.isInteger(sequenceLength) || (sequenceLength as number) < 2
  ) return null;

  // Count distinct earlier games, not FlaggedMove rows: one game may have
  // more than one cascade, and later games are not prior occurrences.
  const priorGames = await prisma.game.findMany({
    where: {
      userId,
      openingName: game.openingName,
      lichessCreatedAt: { lt: game.lichessCreatedAt },
      flags: { some: { flagType: "tilt_cascade", gamePhase: cascade.gamePhase } },
    },
    distinct: ["id"],
    select: { id: true },
  });
  if (priorGames.length < MIN_PRIOR_OCCURRENCES) return null;

  const start = startPly as number;
  const length = sequenceLength as number;
  return {
    startMove: Math.floor(start / 2) + 1,
    endMove: Math.floor(start / 2) + length,
    priorOccurrences: priorGames.length,
  };
}
