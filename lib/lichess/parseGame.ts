import type { ParsedGame } from "@/types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rating(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Converts one raw Lichess NDJSON game object into the flat
 * shape the rest of the app (feature extractor, flag engine) uses.
 */
export function parseGame(raw: unknown, forUsername: string): ParsedGame | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.moves !== "string" ||
    !raw.moves ||
    !isRecord(raw.players)
  ) return null;

  const players = raw.players;
  const white = record(players.white);
  const black = record(players.black);
  const whiteUser = record(white.user);
  const blackUser = record(black.user);
  const whiteName = text(whiteUser.name) ?? "anonymous";
  const blackName = text(blackUser.name) ?? "anonymous";

  const normalizedTarget = forUsername.toLowerCase();

  const isWhite = whiteName.toLowerCase() === normalizedTarget;
  const isBlack = blackName.toLowerCase() === normalizedTarget;
  if (!isWhite && !isBlack) return null; // game doesn't belong to this user

  const playerColor: "white" | "black" = isWhite ? "white" : "black";
  const opponent = isWhite ? black : white;

  const moveArray: string[] = raw.moves.trim().split(/\s+/);
  const clockArray: number[] | null = Array.isArray(raw.clocks) &&
    raw.clocks.every((clock): clock is number => typeof clock === "number" && Number.isFinite(clock))
    ? raw.clocks // Lichess returns clocks in centiseconds, one per ply
    : null;
  const opening = record(raw.opening);
  const opponentUser = record(opponent.user);

  return {
    id: raw.id,
    playerColor,
    opponentUsername: text(opponentUser.name) ?? "anonymous",
    opponentRating: rating(opponent.rating),
    playerRating: rating(isWhite ? white.rating : black.rating),
    moves: moveArray,
    clocks: clockArray,
    openingName: text(opening.name),
    openingEco: text(opening.eco),
    result: deriveResult(raw, playerColor),
    rated: raw.rated === true,
    speed: text(raw.speed),
    createdAt: rating(raw.createdAt),
  };
}

function deriveResult(
  raw: JsonRecord,
  playerColor: "white" | "black"
): "win" | "loss" | "draw" {
  if (raw.status === "draw" || raw.winner === undefined) return "draw";
  return raw.winner === playerColor ? "win" : "loss";
}

/** Convenience batch wrapper. Silently drops games that fail to parse. */
export function parseGames(rawGames: unknown[], forUsername: string): ParsedGame[] {
  const out: ParsedGame[] = [];
  for (const raw of rawGames) {
    const parsed = parseGame(raw, forUsername);
    if (parsed) out.push(parsed);
  }
  return out;
}
