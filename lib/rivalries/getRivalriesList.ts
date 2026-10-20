import { prisma } from "@/lib/prisma";

export interface RivalryCard {
  opponentUsername: string;
  wins: number;
  losses: number;
  draws: number;
  summary: string;
}

/** Only opponents this signed-in user has personally lost to more than once. */
export async function getRivalriesList(userId: string): Promise<RivalryCard[]> {
  const games = await prisma.game.findMany({ where: { userId }, select: { opponentUsername: true, result: true } });
  const byOpponent = new Map<string, { opponentUsername: string; wins: number; losses: number; draws: number }>();
  for (const game of games) {
    const key = game.opponentUsername.trim().toLowerCase();
    const record = byOpponent.get(key) ?? { opponentUsername: game.opponentUsername, wins: 0, losses: 0, draws: 0 };
    if (game.result === "win") record.wins++;
    else if (game.result === "loss") record.losses++;
    else record.draws++;
    byOpponent.set(key, record);
  }
  return [...byOpponent.values()].filter((record) => record.losses > 1).map((record) => ({
    ...record,
    summary: `${record.losses} losses out of ${record.wins + record.losses + record.draws} games.`,
  })).sort((a, b) => b.losses - a.losses || a.opponentUsername.localeCompare(b.opponentUsername));
}
