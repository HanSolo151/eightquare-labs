import { prisma } from "@/lib/prisma";

const MIN_GAMES_FOR_EFFECTIVE_RATING = 3;

export interface EffectiveRatingSignal {
  fires: boolean;
  gamesCount: number;
  avgRating: number | null;
}

export async function getEffectiveRatingSignals(userId: string, opponentUsernames: string[]): Promise<Map<string, EffectiveRatingSignal>> {
  const normalized = [...new Set(opponentUsernames.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const result = new Map<string, EffectiveRatingSignal>(normalized.map((name) => [name, { fires: false, gamesCount: 0, avgRating: null }]));
  if (normalized.length === 0) return result;

  const games = await prisma.game.findMany({
    where: {
      userId,
      OR: normalized.map((name) => ({ opponentUsername: { equals: name, mode: "insensitive" as const } })),
    },
    select: { opponentUsername: true, opponentRating: true },
  });
  const grouped = new Map<string, { gamesCount: number; ratings: number[] }>();
  for (const game of games) {
    const key = game.opponentUsername.trim().toLowerCase();
    const entry = grouped.get(key) ?? { gamesCount: 0, ratings: [] };
    entry.gamesCount++;
    if (game.opponentRating !== null) entry.ratings.push(game.opponentRating);
    grouped.set(key, entry);
  }
  for (const name of normalized) {
    const entry = grouped.get(name);
    if (!entry) continue;
    result.set(name, {
      fires: entry.ratings.length >= MIN_GAMES_FOR_EFFECTIVE_RATING,
      gamesCount: entry.gamesCount,
      avgRating: entry.ratings.length ? Math.round(entry.ratings.reduce((sum, rating) => sum + rating, 0) / entry.ratings.length) : null,
    });
  }
  return result;
}

export async function getEffectiveRatingSignal(userId: string, opponentUsername: string): Promise<EffectiveRatingSignal> {
  const key = opponentUsername.trim().toLowerCase();
  return (await getEffectiveRatingSignals(userId, [opponentUsername])).get(key) ?? {
    fires: false, gamesCount: 0, avgRating: null,
  };
}
