import { Chess } from "chess.js";
import { prisma } from "@/lib/prisma";
import { openingFenKey, OPENING_TREE_PLIES } from "@/lib/profile/openingTree";

export interface DrilldownNode {
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

  type Aggregate = Omit<DrilldownNode, "occurrences" | "flaggedCount" | "avgCpLoss"> & {
    occurrences: number; flaggedPlies: Map<number, number>;
  };
  const byKey = new Map<string, Aggregate>();
  let dangerMove: DrilldownNode | null = null;
  let dangerMoveSeverityRank = 0;
  const severityRank: Record<string, number> = { low: 1, medium: 2, high: 3 };

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
          ply, san: move.san, fenBefore, occurrences: 0, flaggedPlies: new Map(),
          opponentUsername: game.opponentUsername, maiaRating: game.opponentRating,
          humanRating: game.playerRating,
          playerColor: game.playerColor === "black" ? "black" : "white",
        };
        byKey.set(key, entry);
      }
      entry.occurrences++;
      const moveFlags = flagsByPly.get(ply) ?? [];
      if (moveFlags.length) {
        entry.flaggedPlies.set(ply, Math.max(entry.flaggedPlies.get(ply) ?? 0, ...moveFlags.map((flag) => flag.cpLoss)));
        const strongest = [...moveFlags].sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) || b.cpLoss - a.cpLoss)[0];
        const rank = strongest ? severityRank[strongest.severity] ?? 0 : 0;
        if (strongest && (!dangerMove || rank > dangerMoveSeverityRank ||
          (rank === dangerMoveSeverityRank && strongest.cpLoss > (dangerMove.avgCpLoss ?? 0)))) {
          dangerMove = {
            ...entry, flaggedCount: 1, avgCpLoss: strongest.cpLoss,
          };
          dangerMoveSeverityRank = rank;
        }
      }
    }
  }

  const nodes = [...byKey.values()].map((entry) => {
    const losses = [...entry.flaggedPlies.values()];
    return {
      ply: entry.ply, san: entry.san, fenBefore: entry.fenBefore, occurrences: entry.occurrences,
      flaggedCount: losses.length,
      avgCpLoss: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null,
      opponentUsername: entry.opponentUsername, maiaRating: entry.maiaRating,
      humanRating: entry.humanRating, playerColor: entry.playerColor,
    };
  }).sort((a, b) => a.ply - b.ply || b.flaggedCount - a.flaggedCount || a.san.localeCompare(b.san));
  return {
    eco, openingName: games.find((game) => game.openingName)?.openingName ?? null,
    nodes,
    dangerMove,
  };
}
