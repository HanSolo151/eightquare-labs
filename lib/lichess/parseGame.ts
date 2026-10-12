import type { ParsedGame } from "@/types";

/**
 * Converts one raw Lichess NDJSON game object into the flat
 * shape the rest of the app (feature extractor, flag engine) uses.
 */
export function parseGame(raw: any, forUsername: string): ParsedGame | null {
  if (!raw?.moves || !raw?.players) return null;

  const normalizedTarget = forUsername.toLowerCase();
  const whiteName: string = raw.players.white?.user?.name ?? "anonymous";
  const blackName: string = raw.players.black?.user?.name ?? "anonymous";

  const isWhite = whiteName.toLowerCase() === normalizedTarget;
  const isBlack = blackName.toLowerCase() === normalizedTarget;
  if (!isWhite && !isBlack) return null; // game doesn't belong to this user

  const playerColor: "white" | "black" = isWhite ? "white" : "black";
  const opponent = isWhite ? raw.players.black : raw.players.white;

  const moveArray: string[] = raw.moves.trim().split(/\s+/);
  const clockArray: number[] | null = Array.isArray(raw.clocks)
    ? raw.clocks // lichess returns clocks in centiseconds, one per ply
    : null;

  return {
    id: raw.id,
    playerColor,
    opponentUsername: opponent?.user?.name ?? "anonymous",
    opponentRating: opponent?.rating ?? null,
    playerRating:
      (isWhite ? raw.players.white?.rating : raw.players.black?.rating) ?? null,
    moves: moveArray,
    clocks: clockArray,
    openingName: raw.opening?.name ?? null,
    openingEco: raw.opening?.eco ?? null,
    result: deriveResult(raw, playerColor),
    rated: !!raw.rated,
    speed: raw.speed ?? null,
    createdAt: raw.createdAt ?? null,
  };
}

function deriveResult(
  raw: any,
  playerColor: "white" | "black"
): "win" | "loss" | "draw" {
  if (raw.status === "draw" || raw.winner === undefined) return "draw";
  return raw.winner === playerColor ? "win" : "loss";
}

/** Convenience batch wrapper. Silently drops games that fail to parse. */
export function parseGames(rawGames: any[], forUsername: string): ParsedGame[] {
  const out: ParsedGame[] = [];
  for (const raw of rawGames) {
    const parsed = parseGame(raw, forUsername);
    if (parsed) out.push(parsed);
  }
  return out;
}