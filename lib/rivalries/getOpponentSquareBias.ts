import { Chess } from "chess.js";
import { prisma } from "@/lib/prisma";
import { parseSquare } from "@/lib/bias/squareGeometry";
import type { SquareBias } from "@/lib/bias/updateBiasProfile";

/** Builds a flagged-destination distribution for this matchup. Unflagged
 * moves and per-move clock data are not persisted, so this is not a rate. */
export async function getOpponentSquareBias(userId: string, opponentUsername: string): Promise<{ squareBias: SquareBias; sampleSize: number }> {
  const games = await prisma.game.findMany({
    where: { userId, opponentUsername: { equals: opponentUsername, mode: "insensitive" } },
    select: {
      moves: true, playerColor: true,
      flags: { select: { ply: true, cpLoss: true, flagType: true, color: true } },
    },
  });
  const squareBias: SquareBias = {};
  let sampleSize = 0;

  for (const game of games) {
    const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
    const flagsByPly = new Map<number, typeof game.flags>();
    for (const flag of game.flags) {
      if (flag.color !== game.playerColor) continue;
      flagsByPly.set(flag.ply, [...(flagsByPly.get(flag.ply) ?? []), flag]);
    }
    const chess = new Chess();
    for (let ply = 0; ply < moves.length; ply++) {
      let move;
      try { move = chess.move(moves[ply]); } catch { break; }
      if (!move) break;
      const isPlayersTurn = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
      if (!isPlayersTurn) continue;
      const flags = flagsByPly.get(ply) ?? [];
      if (!flags.length || !parseSquare(move.to)) continue;

      const square = squareBias[move.to] ??= {
        moveCount: 0, flaggedCount: 0, totalCpLoss: 0,
        under30Count: 0, clockDataCount: 0, flagTypeCounts: {},
      };
      // Each source ply contributes once even when multiple flag types overlap.
      square.flaggedCount++;
      square.totalCpLoss += Math.max(...flags.map((flag) => flag.cpLoss));
      for (const flag of flags) square.flagTypeCounts[flag.flagType] = (square.flagTypeCounts[flag.flagType] ?? 0) + 1;
      sampleSize++;
    }
  }
  return { squareBias, sampleSize };
}
