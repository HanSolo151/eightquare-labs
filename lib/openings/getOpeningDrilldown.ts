import { Chess } from "chess.js";
import { prisma } from "@/lib/prisma";
import { openingFenKey, OPENING_TREE_PLIES } from "@/lib/profile/openingTree";
import { getEffectiveRatingSignals } from "@/lib/opponent/effectiveRating";
import { findWorstFlaggedMove } from "@/lib/flags/findWorstFlaggedMove";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";

export interface DrilldownNode {
  resolutionTarget: { gameId: string; ply: number } | null;
  ply: number;
  san: string;
  fenBefore: string;
  occurrences: number;
  flaggedCount: number;
  avgCpLoss: number | null;
  opponentUsername: string;
  maiaRating: number | null;
  humanRating: number | null;
  playerColor: "white" | "black";
  effectiveRatingFires: boolean;
}

export interface OpeningDrilldown {
  eco: string;
  openingName: string | null;
  nodes: DrilldownNode[];
  dangerMove: DrilldownNode | null;
}

/** Computes the signed-in player's first 14 plies for an ECO on demand. */
export async function getOpeningDrilldown(userId: string, eco: string): Promise<OpeningDrilldown | null> {
  const games = await prisma.game.findMany({
    where: { userId, openingEco: eco },
    select: {
      id: true, moves: true, playerColor: true, openingName: true,
      opponentUsername: true, opponentRating: true, playerRating: true,
      flags: { select: { ply: true, cpLoss: true, severity: true } },
    },
  });
  if (games.length === 0) return null;
  const effectiveRatings = await getEffectiveRatingSignals(userId, games.map((game) => game.opponentUsername));

  type Aggregate = Omit<DrilldownNode, "occurrences" | "flaggedCount" | "avgCpLoss" | "resolutionTarget"> & {
    occurrences: number; flaggedPositions: Map<string, { gameId: string; ply: number; cpLoss: number; fenBefore: string }>;
  };
  const byKey = new Map<string, Aggregate>();
  for (const game of games) {
    const moves = Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [];
    const flagsByPly = new Map<number, typeof game.flags>();
    for (const flag of game.flags) flagsByPly.set(flag.ply, [...(flagsByPly.get(flag.ply) ?? []), flag]);
    const chess = new Chess();
    const plyLimit = Math.min(moves.length, OPENING_TREE_PLIES);
    for (let ply = 0; ply < plyLimit; ply++) {
      const moverColor = ply % 2 === 0 ? "white" : "black";
      const fenBefore = chess.fen();
      let move;
      try { move = chess.move(moves[ply]); } catch { break; }
      if (!move) break;
      if (moverColor !== game.playerColor) continue;

      const key = `${openingFenKey(fenBefore)}|${move.from}${move.to}${move.promotion ?? ""}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          ply, san: move.san, fenBefore, occurrences: 0, flaggedPositions: new Map(),
          opponentUsername: game.opponentUsername, maiaRating: game.opponentRating,
          humanRating: game.playerRating,
          playerColor: game.playerColor === "black" ? "black" : "white",
          effectiveRatingFires: effectiveRatings.get(game.opponentUsername.trim().toLowerCase())?.fires ?? false,
        };
        byKey.set(key, entry);
      }
      entry.occurrences++;
      const moveFlags = flagsByPly.get(ply) ?? [];
      if (moveFlags.length) {
        const cpLoss = Math.max(...moveFlags.map((flag) => flag.cpLoss));
        entry.flaggedPositions.set(`${game.id}:${ply}`, { gameId: game.id, ply, cpLoss, fenBefore });
      }
    }
  }

  const nodes = [...byKey.values()].map((entry) => {
    const flaggedPositions = [...entry.flaggedPositions.values()].sort((a, b) => b.cpLoss - a.cpLoss);
    const losses = flaggedPositions.map((position) => position.cpLoss);
    const matchingResolutionTarget = flaggedPositions.find((position) => position.fenBefore === entry.fenBefore);
    return {
      ply: entry.ply, san: entry.san, fenBefore: entry.fenBefore, occurrences: entry.occurrences,
      flaggedCount: losses.length,
      avgCpLoss: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null,
      resolutionTarget: matchingResolutionTarget
        ? { gameId: matchingResolutionTarget.gameId, ply: matchingResolutionTarget.ply }
        : null,
      opponentUsername: entry.opponentUsername, maiaRating: entry.maiaRating,
      humanRating: entry.humanRating, playerColor: entry.playerColor,
      effectiveRatingFires: entry.effectiveRatingFires,
    };
  }).sort((a, b) => a.ply - b.ply || b.flaggedCount - a.flaggedCount || a.san.localeCompare(b.san));
  const worst = await findWorstFlaggedMove({ userId, openingEco: eco });
  const worstEffectiveRating = worst
    ? await getEffectiveRatingSignal(userId, worst.opponentUsername)
    : null;
  const dangerMove: DrilldownNode | null = worst ? {
    resolutionTarget: { gameId: worst.gameId, ply: worst.ply },
    ply: worst.ply,
    san: worst.san,
    fenBefore: worst.fen,
    occurrences: 1,
    flaggedCount: 1,
    avgCpLoss: worst.cpLoss,
    opponentUsername: worst.opponentUsername,
    maiaRating: worst.maiaRating,
    humanRating: worst.humanRating,
    playerColor: worst.playerColor,
    effectiveRatingFires: worstEffectiveRating?.fires ?? false,
  } : null;
  return {
    eco, openingName: games.find((game) => game.openingName)?.openingName ?? null,
    nodes,
    dangerMove,
  };
}
