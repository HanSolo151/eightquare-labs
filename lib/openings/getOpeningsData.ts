import { prisma } from "@/lib/prisma";
import { computeDangerScores, type DangerBadge } from "./dangerScore";

const MIN_GAMES_FOR_OPENING = 2;

export interface OpeningRow {
  name: string;
  eco: string | null;
  gamesPlayed: number;
  winRate: number;
  lossRate: number;
  flagCount: number;
  avgCpLoss: number;
  flagDensity: number;
  dangerScore: number;
  badge: DangerBadge;
  sparkline: { moveNumber: number; avgCpLoss: number }[];
}

export async function getOpeningsData(userId: string): Promise<OpeningRow[]> {
  const [games, flags] = await Promise.all([
    prisma.game.findMany({
      where: { userId },
      select: { id: true, openingName: true, openingEco: true, result: true, moves: true, playerColor: true },
    }),
    prisma.flaggedMove.findMany({
      where: { game: { userId } },
      select: { gameId: true, ply: true, cpLoss: true, moveNumber: true },
    }),
  ]);

  type MoveLoss = { cpLoss: number; moveNumber: number };
  type Aggregate = {
    name: string; eco: string | null; games: typeof games;
    wins: number; losses: number; flags: Map<string, MoveLoss>;
  };
  const aggregates = new Map<string, Aggregate>();
  const keyFor = (eco: string | null, name: string) => eco ? `eco:${eco}` : `name:${name}`;

  for (const game of games) {
    if (!game.openingName) continue;
    const key = keyFor(game.openingEco, game.openingName);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = { name: game.openingName, eco: game.openingEco, games: [], wins: 0, losses: 0, flags: new Map() };
      aggregates.set(key, aggregate);
    }
    aggregate.games.push(game);
    if (game.result === "win") aggregate.wins++;
    if (game.result === "loss") aggregate.losses++;
  }

  const gameToAggregate = new Map<string, Aggregate>();
  for (const aggregate of aggregates.values()) for (const game of aggregate.games) gameToAggregate.set(game.id, aggregate);
  for (const flag of flags) {
    const aggregate = gameToAggregate.get(flag.gameId);
    if (!aggregate || !Number.isFinite(flag.cpLoss)) continue;
    const key = `${flag.gameId}:${flag.ply}`;
    const previous = aggregate.flags.get(key);
    // Several flag types can share a ply. Count that move once and use its
    // strongest persisted cpLoss rather than inflating opening danger.
    if (!previous || flag.cpLoss > previous.cpLoss) {
      aggregate.flags.set(key, { cpLoss: flag.cpLoss, moveNumber: flag.moveNumber });
    }
  }

  const raw = [...aggregates.values()].flatMap((aggregate) => {
    const gamesPlayed = aggregate.games.length;
    if (gamesPlayed < MIN_GAMES_FOR_OPENING) return [];
    const ownMoves = aggregate.games.reduce((sum, game) => {
      const plies = Array.isArray(game.moves) ? game.moves.length : 0;
      return sum + (game.playerColor === "white" ? Math.ceil(plies / 2) : Math.floor(plies / 2));
    }, 0);
    const lossesByMove = new Map<number, { total: number; count: number }>();
    let totalCpLoss = 0;
    for (const move of aggregate.flags.values()) {
      totalCpLoss += move.cpLoss;
      const bucket = lossesByMove.get(move.moveNumber) ?? { total: 0, count: 0 };
      bucket.total += move.cpLoss;
      bucket.count++;
      lossesByMove.set(move.moveNumber, bucket);
    }
    const flagCount = aggregate.flags.size;
    return [{
      name: aggregate.name, eco: aggregate.eco, gamesPlayed,
      winRate: aggregate.wins / gamesPlayed, lossRate: aggregate.losses / gamesPlayed,
      flagCount, avgCpLoss: ownMoves ? totalCpLoss / ownMoves : 0,
      flagDensity: gamesPlayed ? flagCount / gamesPlayed : 0,
      sparkline: [...lossesByMove.entries()].sort(([a], [b]) => a - b)
        .map(([moveNumber, bucket]) => ({ moveNumber, avgCpLoss: bucket.total / bucket.count })),
    }];
  });

  return computeDangerScores(raw).sort((a, b) => b.dangerScore - a.dangerScore || a.name.localeCompare(b.name));
}
