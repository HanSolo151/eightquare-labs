import { Chess } from "chess.js";
import { prisma } from "@/lib/prisma";

const SKIP_COOLDOWN_DAYS = 3;
const SKIP_RETIRE_THRESHOLD = 3;

export interface DailyPuzzle {
  gameId: string;
  ply: number;
  fenBefore: string;
  playerColor: "white" | "black";
  opponentUsername: string;
  cpLoss: number;
  severity: string;
}

export async function getDailyPuzzle(userId: string): Promise<DailyPuzzle | null> {
  const [flags, states] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      orderBy: { cpLoss: "desc" },
      select: {
        ply: true, cpLoss: true, severity: true, color: true,
        game: { select: { id: true, moves: true, playerColor: true, opponentUsername: true } },
      },
    }),
    prisma.dailyPuzzleState.findMany({ where: { userId } }),
  ]);
  const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  flags.sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) || b.cpLoss - a.cpLoss);

  const stateByKey = new Map(states.map((state) => [`${state.gameId}:${state.ply}`, state]));
  const cooldownMs = SKIP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const flag of flags) {
    const { game } = flag;
    const key = `${game.id}:${flag.ply}`;
    const state = stateByKey.get(key);
    if (state?.status === "solved" || state?.status === "deferred") continue;
    if (state?.lastSkippedAt && now - state.lastSkippedAt.getTime() < cooldownMs) continue;
    if (flag.color !== game.playerColor) continue;

    const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
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
    if (!valid || chess.turn() !== (game.playerColor === "white" ? "w" : "b")) continue;

    return {
      gameId: game.id, ply: flag.ply, fenBefore: chess.fen(),
      playerColor: game.playerColor === "black" ? "black" : "white",
      opponentUsername: game.opponentUsername, cpLoss: flag.cpLoss, severity: flag.severity,
    };
  }
  return null;
}

export { SKIP_RETIRE_THRESHOLD };
