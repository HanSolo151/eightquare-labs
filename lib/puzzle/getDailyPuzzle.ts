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

export interface DailyPuzzleSnapshot {
  puzzle: DailyPuzzle | null;
  trackingAvailable: boolean;
}

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2021";
}

export async function getDailyPuzzle(userId: string): Promise<DailyPuzzleSnapshot> {
  const [flags, statesResult, resolvedResult] = await Promise.all([
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      orderBy: { cpLoss: "desc" },
      select: {
        ply: true, cpLoss: true, severity: true, color: true,
        game: { select: { id: true, moves: true, playerColor: true, opponentUsername: true } },
      },
    }),
    prisma.dailyPuzzleState.findMany({ where: { userId } })
      .then((items) => ({ items, available: true as const }))
      .catch((error: unknown) => {
        if (isMissingTable(error)) return { items: [], available: false as const };
        throw error;
      }),
    prisma.resolvedSparPosition.findMany({ where: { userId }, select: { gameId: true, ply: true } })
      .then((items) => ({ items, available: true as const }))
      .catch((error: unknown) => {
        if (isMissingTable(error)) return { items: [], available: false as const };
        throw error;
      }),
  ]);
  if (!statesResult.available || !resolvedResult.available) {
    return { puzzle: null, trackingAvailable: false };
  }
  const states = statesResult.items;
  const resolved = resolvedResult.items;
  const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  flags.sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) || b.cpLoss - a.cpLoss);

  const stateByKey = new Map(states.map((state) => [`${state.gameId}:${state.ply}`, state]));
  const resolvedKeys = new Set(resolved.map((item) => `${item.gameId}:${item.ply}`));
  const cooldownMs = SKIP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const flag of flags) {
    const { game } = flag;
    const key = `${game.id}:${flag.ply}`;
    const state = stateByKey.get(key);
    if (resolvedKeys.has(key) || state?.status === "solved" || state?.status === "deferred") continue;
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
      puzzle: {
        gameId: game.id, ply: flag.ply, fenBefore: chess.fen(),
        playerColor: game.playerColor === "black" ? "black" : "white",
        opponentUsername: game.opponentUsername, cpLoss: flag.cpLoss, severity: flag.severity,
      },
      trackingAvailable: true,
    };
  }
  return { puzzle: null, trackingAvailable: true };
}

export { SKIP_RETIRE_THRESHOLD };
