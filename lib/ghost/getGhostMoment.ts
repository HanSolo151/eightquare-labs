import { Chess } from "chess.js";
import { prisma } from "@/lib/prisma";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";

export interface GhostMoment {
  gameId: string;
  ply: number;
  moves: string[];
  fenBefore: string;
  playedSan: string;
  playedUci: string;
  cpLoss: number;
  playerColor: "white" | "black";
  playerRating: number | null;
  opponentRating: number | null;
  opponentUsername: string;
  effectiveRatingFires: boolean;
}

/** Returns the worst persisted flag and the position before its move. */
export async function getGhostMoment(userId: string, gameId: string, targetPly?: number): Promise<GhostMoment | null> {
  const game = await prisma.game.findFirst({
    where: { id: gameId, userId },
    select: {
      id: true, moves: true, playerColor: true, playerRating: true,
      opponentRating: true, opponentUsername: true,
      flags: {
        where: targetPly === undefined ? undefined : { ply: targetPly },
        orderBy: [{ cpLoss: "desc" }, { ply: "asc" }],
        select: { ply: true, cpLoss: true, color: true },
      },
    },
  });
  if (!game || game.flags.length === 0) return null;
  // Older saved analyses can contain a flag for the opponent's move. Ghost
  // replay is a drill for the signed-in player's decisions, so never use one
  // of those rows as the starting point.
  const worst = game.flags.find((flag) => flag.color === game.playerColor);
  if (!worst) return null;
  const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
  if (!Number.isInteger(worst.ply) || worst.ply < 0 || worst.ply >= moves.length) return null;

  const chess = new Chess();
  for (let ply = 0; ply < worst.ply; ply++) {
    try {
      if (!chess.move(moves[ply])) return null;
    } catch {
      return null;
    }
  }
  const fenBefore = chess.fen();
  let played;
  try { played = chess.move(moves[worst.ply]); } catch { return null; }
  if (!played) return null;

  const effectiveRating = await getEffectiveRatingSignal(userId, game.opponentUsername);

  return {
    gameId: game.id, ply: worst.ply, moves, fenBefore, playedSan: played.san,
    playedUci: played.from + played.to + (played.promotion ?? ""), cpLoss: worst.cpLoss,
    playerColor: game.playerColor === "black" ? "black" : "white",
    playerRating: game.playerRating, opponentRating: game.opponentRating,
    opponentUsername: game.opponentUsername,
    effectiveRatingFires: effectiveRating.fires,
  };
}
