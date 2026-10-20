import { Chess } from "chess.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface WorstMoveTarget {
  gameId: string;
  ply: number;
  san: string;
  fen: string;
  cpLoss: number;
  opponentUsername: string;
  maiaRating: number | null;
  humanRating: number | null;
  playerColor: "white" | "black";
}

/** Finds the highest-cp-loss high-severity move in a caller-scoped set of games. */
export async function findWorstFlaggedMove(gameWhere: Prisma.GameWhereInput): Promise<WorstMoveTarget | null> {
  const games = await prisma.game.findMany({
    where: gameWhere,
    select: {
      id: true, moves: true, playerColor: true, opponentUsername: true,
      opponentRating: true, playerRating: true,
      flags: {
        where: { severity: "high" },
        orderBy: [{ cpLoss: "desc" }, { ply: "asc" }],
        take: 1,
        select: { ply: true, san: true, cpLoss: true },
      },
    },
  });

  const candidates = games.flatMap((game) => game.flags[0] ? [{ game, flag: game.flags[0] }] : [])
    .sort((a, b) => b.flag.cpLoss - a.flag.cpLoss || a.flag.ply - b.flag.ply);

  for (const { game, flag } of candidates) {
    const moves = Array.isArray(game.moves)
      ? game.moves.filter((move): move is string => typeof move === "string")
      : [];
    if (!Number.isInteger(flag.ply) || flag.ply < 0 || flag.ply >= moves.length) continue;

    const chess = new Chess();
    let valid = true;
    for (let ply = 0; ply < flag.ply; ply++) {
      try {
        if (!chess.move(moves[ply])) { valid = false; break; }
      } catch {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    return {
      gameId: game.id,
      ply: flag.ply,
      san: flag.san,
      fen: chess.fen(),
      cpLoss: flag.cpLoss,
      opponentUsername: game.opponentUsername,
      maiaRating: game.opponentRating,
      humanRating: game.playerRating,
      playerColor: game.playerColor === "black" ? "black" : "white",
    };
  }
  return null;
}
