import { prisma } from "@/lib/prisma";

export const DASHBOARD_GAMES_PAGE_SIZE = 20;

export interface DashboardGameFlag {
  ply: number;
  san: string;
  flagType: string;
  severity: string;
  cpLoss: number;
}

export interface DashboardGame {
  id: string;
  lichessGameId: string;
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  playerColor: string;
  result: string;
  openingName: string | null;
  openingEco: string | null;
  speed: string | null;
  rated: boolean;
  createdAt: Date | null;
  moveCount: number;
  moves?: string[];
  clocks?: number[] | null;
  clockInitialSec?: number | null;
  clockIncrementSec?: number | null;
  evaluationDepth16?: boolean;
  evaluated: boolean;
  flags: DashboardGameFlag[];
}

export interface DashboardGamesData {
  games: DashboardGame[];
  page: number;
  pageSize: number;
  totalGames: number;
  totalPages: number;
  evaluatedGames: number;
}

/** Paged, account-scoped read model for the dashboard Games screen. */
export async function getGamesData(
  userId: string,
  requestedPage = 1,
  filter?: { openingEco?: string; severity?: "low" | "medium" | "high"; phase?: "opening" | "middlegame" | "endgame"; gameIds?: string[] },
  includeMoves = false,
): Promise<DashboardGamesData> {
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
  const where = {
    userId,
    ...(filter?.gameIds ? { id: { in: filter.gameIds } } : {}),
    ...(filter?.openingEco ? { openingEco: filter.openingEco } : {}),
    ...(filter?.severity || filter?.phase
      ? { flags: { some: { ...(filter.severity ? { severity: filter.severity } : {}), ...(filter.phase ? { gamePhase: filter.phase } : {}) } } }
      : {}),
  };
  const [totalGames, evaluatedGames] = await Promise.all([
    prisma.game.count({ where }),
    prisma.game.count({ where: { ...where, eval: { isNot: null } } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalGames / DASHBOARD_GAMES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const rows = await prisma.game.findMany({
    where,
    orderBy: [
      { lichessCreatedAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
    skip: (safePage - 1) * DASHBOARD_GAMES_PAGE_SIZE,
    take: DASHBOARD_GAMES_PAGE_SIZE,
    select: {
      id: true,
      lichessGameId: true,
      opponentUsername: true,
      opponentRating: true,
      playerRating: true,
      playerColor: true,
      result: true,
      openingName: true,
      openingEco: true,
      speed: true,
      rated: true,
      lichessCreatedAt: true,
      moves: true,
      clocks: true,
      clockInitialSec: true,
      clockIncrementSec: true,
      eval: { select: { gameId: true, engineVersion: true, points: true } },
      flags: {
        orderBy: { ply: "asc" },
        select: { ply: true, san: true, flagType: true, severity: true, cpLoss: true },
      },
    },
  });

  const games: DashboardGame[] = rows.map((row) => ({
    id: row.id,
    lichessGameId: row.lichessGameId,
    opponentUsername: row.opponentUsername,
    opponentRating: row.opponentRating,
    playerRating: row.playerRating,
    playerColor: row.playerColor,
    result: row.result,
    openingName: row.openingName,
    openingEco: row.openingEco,
    speed: row.speed,
    rated: row.rated,
    createdAt: row.lichessCreatedAt,
    moveCount: Array.isArray(row.moves) ? row.moves.length : 0,
    ...(includeMoves
      ? {
          moves: Array.isArray(row.moves) ? row.moves.filter((move): move is string => typeof move === "string") : [],
          clocks: Array.isArray(row.clocks) && row.clocks.every((clock) => typeof clock === "number" && Number.isFinite(clock))
            ? row.clocks as number[]
            : null,
          clockInitialSec: row.clockInitialSec,
          clockIncrementSec: row.clockIncrementSec,
          evaluationDepth16: row.eval?.engineVersion === "stockfish-19-lite-single-depth16-target-v3" &&
            Array.isArray(row.eval.points) &&
            row.eval.points.length === (Array.isArray(row.moves) ? row.moves.length : -1) &&
            row.eval.points.every((point) =>
              typeof point === "object" &&
              point !== null &&
              !Array.isArray(point) &&
              "depth" in point &&
              typeof point.depth === "number" &&
              Number.isFinite(point.depth) &&
              point.depth >= 16),
        }
      : {}),
    evaluated: row.eval !== null,
    flags: row.flags,
  }));

  return { games, page: safePage, pageSize: DASHBOARD_GAMES_PAGE_SIZE, totalGames, totalPages, evaluatedGames };
}
