import { prisma } from "@/lib/prisma";
import { buildBiasData, type BiasData } from "@/lib/bias/getBiasData";
import { getOpponentSquareBias } from "./getOpponentSquareBias";
import { getOpeningsData } from "@/lib/openings/getOpeningsData";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";
import { findWorstFlaggedMove } from "@/lib/flags/findWorstFlaggedMove";

export interface RivalryDetail {
  opponentUsername: string;
  wins: number;
  losses: number;
  draws: number;
  streak: { result: "win" | "loss" | "draw"; count: number } | null;
  heatmap: BiasData;
  openings: Awaited<ReturnType<typeof getOpeningsData>>;
  dangerMove: Awaited<ReturnType<typeof findWorstFlaggedMove>>;
  effectiveRatingFires: boolean;
}

export async function getRivalryDetail(userId: string, opponentUsername: string): Promise<RivalryDetail | null> {
  const games = await prisma.game.findMany({
    where: { userId, opponentUsername: { equals: opponentUsername, mode: "insensitive" } },
    orderBy: [{ lichessCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { result: true },
  });
  if (!games.length) return null;
  const totals = { wins: 0, losses: 0, draws: 0 };
  for (const game of games) {
    if (game.result === "win") totals.wins++;
    else if (game.result === "loss") totals.losses++;
    else totals.draws++;
  }
  const firstResult = games[0].result;
  const streakResult = firstResult === "win" || firstResult === "loss" ? firstResult : "draw";
  let streakCount = 0;
  for (const game of games) {
    if (game.result !== streakResult) break;
    streakCount++;
  }

  const [{ squareBias, sampleSize }, openings, effectiveRating, dangerMove] = await Promise.all([
    getOpponentSquareBias(userId, opponentUsername),
    getOpeningsData(userId, opponentUsername),
    getEffectiveRatingSignal(userId, opponentUsername),
    findWorstFlaggedMove({ userId, opponentUsername: { equals: opponentUsername, mode: "insensitive" } }),
  ]);
  return {
    opponentUsername,
    ...totals,
    streak: { result: streakResult, count: streakCount },
    heatmap: buildBiasData(squareBias, sampleSize, { blunderDensityOnly: true }),
    openings,
    dangerMove,
    effectiveRatingFires: effectiveRating.fires,
  };
}
