import { prisma } from "@/lib/prisma";

export interface NearMissItem {
  gameId: string;
  opponentUsername: string;
  result: "loss" | "draw";
  openingName: string | null;
  ply: number;
  san: string;
  /** `flipped`: centipawn swing; `chance`: player advantage at that position. */
  cp: number;
  mode: "flipped" | "chance";
}

type EvalPointRecord = { cpBefore: number | null; cpAfter: number | null };

function readPoints(value: unknown): EvalPointRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((point) => {
    if (!point || typeof point !== "object") return { cpBefore: null, cpAfter: null };
    const record = point as Record<string, unknown>;
    return {
      cpBefore: typeof record.cpBefore === "number" && Number.isFinite(record.cpBefore) ? record.cpBefore : null,
      cpAfter: typeof record.cpAfter === "number" && Number.isFinite(record.cpAfter) ? record.cpAfter : null,
    };
  });
}

/** Finds recent losses/draws that either dropped a winning edge or contained
 * a winning chance. The scores are mover-POV in storage and converted here.
 */
export async function getNearMisses(userId: string): Promise<NearMissItem[]> {
  const games = await prisma.game.findMany({
    where: { userId, result: { in: ["loss", "draw"] }, eval: { isNot: null } },
    orderBy: { lichessCreatedAt: { sort: "desc", nulls: "last" } },
    take: 100,
    select: {
      id: true, playerColor: true, result: true, opponentUsername: true,
      openingName: true, moves: true,
      eval: { select: { points: true } },
    },
  });
  const result: NearMissItem[] = [];
  for (const game of games) {
    if (!game.eval || (game.playerColor !== "white" && game.playerColor !== "black")) continue;
    const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
    const points = readPoints(game.eval.points);
    let flipped: NearMissItem | null = null;
    let bestChance: NearMissItem | null = null;
    for (let ply = 0; ply < points.length; ply++) {
      const point = points[ply];
      const moverColor = ply % 2 === 0 ? "white" : "black";
      const sign = moverColor === game.playerColor ? 1 : -1;
      const beforeCp = point.cpBefore === null ? null : point.cpBefore * sign;
      const afterCp = point.cpAfter === null ? null : point.cpAfter * sign;
      if (moverColor === game.playerColor && beforeCp !== null && afterCp !== null && beforeCp >= 100 && afterCp <= 0) {
        const loss = beforeCp - afterCp;
        if (!flipped || loss > flipped.cp) {
          flipped = { gameId: game.id, opponentUsername: game.opponentUsername, result: game.result as "loss" | "draw", openingName: game.openingName, ply, san: moves[ply] ?? "Move unavailable", cp: loss, mode: "flipped" };
        }
      }
      const candidateChances = [
        beforeCp === null ? null : { cp: beforeCp, positionPly: ply },
        afterCp === null ? null : { cp: afterCp, positionPly: ply + 1 },
      ];
      for (const chance of candidateChances) {
        if (chance && chance.cp >= 100 && (!bestChance || chance.cp > bestChance.cp)) {
          const movePly = Math.max(0, chance.positionPly - 1);
          bestChance = { gameId: game.id, opponentUsername: game.opponentUsername, result: game.result as "loss" | "draw", openingName: game.openingName, ply: chance.positionPly, san: moves[movePly] ?? "Move unavailable", cp: chance.cp, mode: "chance" };
        }
      }
    }
    if (flipped) result.push(flipped);
    if (bestChance) result.push(bestChance);
  }
  return result;
}
