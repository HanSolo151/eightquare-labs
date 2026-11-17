import { prisma } from "@/lib/prisma";
import { getBiasData, type BiasData } from "@/lib/bias/getBiasData";
import type { FlaggedMove } from "@/types";
import type { ProfileFlaggedMoment, UserProfileCache } from "@/lib/profile-cache-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPatternLabels(value: unknown): UserProfileCache["patternLabels"] {
  if (!Array.isArray(value)) return {};
  const labels: UserProfileCache["patternLabels"] = {};
  for (const rawPattern of value) {
    if (!isRecord(rawPattern) || !Array.isArray(rawPattern.tags) || !Array.isArray(rawPattern.occurrences)) continue;
    const occurrences = rawPattern.occurrences.filter((entry): entry is { gameId: string; ply: number } =>
      isRecord(entry) && typeof entry.gameId === "string" && Number.isInteger(entry.ply));
    for (const tag of rawPattern.tags) {
      if (typeof tag !== "string" || !tag) continue;
      labels[tag] = [...(labels[tag] ?? []), ...occurrences];
    }
  }
  return labels;
}

function nemesisSquare(heatmap: BiasData): string | null {
  if (!heatmap.meetsThreshold) return null;
  const top = [...heatmap.squares.blunderDensity]
    .sort((a, b) => b.flaggedCount - a.flaggedCount)[0];
  return top && top.flaggedCount >= 3 ? top.square : null;
}

function toProfileFlag(flag: {
  ply: number;
  moveNumber: number;
  san: string;
  color: string;
  flagType: string;
  severity: string;
  cpLoss: number | null;
  mateBefore: number | null;
  mateAfter: number | null;
  gamePhase: string;
  explanation: string;
  game: { id: string; lichessGameId: string; opponentUsername: string; openingName: string | null; openingEco: string | null; result: string; lichessCreatedAt: Date | null };
}): ProfileFlaggedMoment {
  return {
    gameId: flag.game.lichessGameId,
    internalGameId: flag.game.id,
    opponentUsername: flag.game.opponentUsername,
    openingName: flag.game.openingName,
    openingEco: flag.game.openingEco,
    result: flag.game.result === "win" || flag.game.result === "loss" ? flag.game.result : "draw",
    playedAt: flag.game.lichessCreatedAt?.getTime() ?? null,
    ply: flag.ply,
    moveNumber: flag.moveNumber,
    san: flag.san,
    color: flag.color as FlaggedMove["color"],
    flagType: flag.flagType as FlaggedMove["flagType"],
    severity: flag.severity as FlaggedMove["severity"],
    cpLoss: flag.cpLoss,
    mateBefore: flag.mateBefore,
    mateAfter: flag.mateAfter,
    gamePhase: flag.gamePhase as FlaggedMove["gamePhase"],
    explanation: flag.explanation,
  };
}

export async function readUserProfileCache(userId: string): Promise<UserProfileCache | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, lastSyncedAt: true },
  });
  if (!user) return null;

  const [flags, weakness, heatmapData] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      orderBy: [{ game: { lichessCreatedAt: { sort: "desc", nulls: "last" } } }, { ply: "desc" }],
      select: {
        ply: true, moveNumber: true, san: true, color: true, flagType: true,
        severity: true, cpLoss: true, mateBefore: true, mateAfter: true, gamePhase: true, explanation: true,
        game: { select: { id: true, lichessGameId: true, opponentUsername: true, openingName: true, openingEco: true, result: true, lichessCreatedAt: true } },
      },
    }),
    prisma.weaknessProfileRow.findUnique({ where: { userId }, select: { patterns: true } }),
    getBiasData(userId),
  ]);

  const flaggedMoments = flags.map(toProfileFlag);
  const patternLabels: UserProfileCache["patternLabels"] = readPatternLabels(weakness?.patterns);
  for (const flag of flaggedMoments) {
    patternLabels[flag.flagType] = [...(patternLabels[flag.flagType] ?? []), { gameId: flag.gameId, ply: flag.ply }];
  }

  return {
    userId: user.id,
    flaggedMoments,
    patternLabels,
    heatmapData,
    nemesisSquare: nemesisSquare(heatmapData),
    lastSyncedAt: user.lastSyncedAt?.getTime() ?? null,
    pendingNewGamesCount: 0,
  };
}
