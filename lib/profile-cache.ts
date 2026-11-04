"use client";

import { signIn } from "next-auth/react";
import { Chess } from "chess.js";
import type { FlaggedMove, GameEval, MoveFeature, ParsedGame, PlayerProfile, WeaknessProfile } from "@/types";
import type { DashboardGamesData, DashboardGame } from "@/lib/dashboard/getGamesData";
import type { PgnSessionResult, UserProfileCache } from "@/lib/profile-cache-types";

const PROFILE_DB_NAME = "eightsquare-user-profile-cache";
const PROFILE_STORE = "profiles";
const PROFILE_DB_VERSION = 1;
const PGN_SESSION_KEY = "eightsquare:pgn-session:v1";
const PROFILE_CACHE_REFRESH_EVENT = "eightsquare:profile-cache-refreshed";
const PROFILE_CACHE_ERROR_EVENT = "eightsquare:profile-cache-error";
const PROFILE_SYNC_ENGINE_VERSION = "stockfish-19-lite-single-depth16-target-v3";

type NewGamesResponse = {
  userId: string;
  newGamesCount: number;
  capped: boolean;
  lastGameTimestamp: number | null;
};

function requireBrowser(): void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    throw new Error("Profile cache is only available in a browser.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfileCache(value: unknown, userId: string): value is UserProfileCache {
  return isRecord(value) &&
    value.userId === userId &&
    Array.isArray(value.flaggedMoments) &&
    isRecord(value.patternLabels) &&
    isRecord(value.heatmapData) &&
    (value.nemesisSquare === null || typeof value.nemesisSquare === "string") &&
    (value.lastSyncedAt === null || typeof value.lastSyncedAt === "number") &&
    typeof value.pendingNewGamesCount === "number" &&
    Number.isInteger(value.pendingNewGamesCount) &&
    value.pendingNewGamesCount >= 0;
}

async function openProfileDb(): Promise<IDBDatabase> {
  requireBrowser();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROFILE_DB_NAME, PROFILE_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROFILE_STORE)) {
        request.result.createObjectStore(PROFILE_STORE, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the profile cache."));
  });
}

async function readProfileCache(userId: string): Promise<UserProfileCache | null> {
  const db = await openProfileDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STORE, "readonly");
    const request = transaction.objectStore(PROFILE_STORE).get(userId);
    let result: UserProfileCache | null = null;
    request.onsuccess = () => {
      if (request.result === undefined) return;
      if (!isProfileCache(request.result, userId)) {
        reject(new Error("Cached profile has an invalid shape."));
        return;
      }
      result = request.result;
    };
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Could not read the profile cache."));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("Profile cache read was aborted."));
    };
  });
}

export async function saveProfileCache(profile: UserProfileCache): Promise<void> {
  const db = await openProfileDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STORE, "readwrite");
    transaction.objectStore(PROFILE_STORE).put(profile);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Could not save the profile cache."));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("Profile cache write was aborted."));
    };
  });
}

async function readPostgresProfile(userId: string): Promise<UserProfileCache> {
  const response = await fetch("/api/profile-cache", { cache: "no-store" });
  if (!response.ok) throw await responseError(response, "Could not load your saved profile.");
  const profile: unknown = await response.json();
  if (!isProfileCache(profile, userId)) {
    throw new Error("The saved profile does not match the signed-in account.");
  }
  return profile;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload: unknown = await response.json().catch(() => null);
  const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : fallback;
  return new Error(`${message} (${response.status})`);
}

function reportBackgroundError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Background profile refresh failed:", error);
  window.dispatchEvent(new CustomEvent(PROFILE_CACHE_ERROR_EVENT, { detail: { message } }));
}

/**
 * Returns IndexedDB data immediately when available. A database miss is
 * rehydrated from Postgres before it is cached; the Lichess freshness check
 * never blocks the profile render.
 */
export async function loadProfile(userId: string): Promise<UserProfileCache> {
  if (!userId.trim()) throw new Error("A user ID is required to load a profile.");
  requireBrowser();

  const cached = await readProfileCache(userId);
  if (cached) {
    void checkForNewGames(userId).catch(reportBackgroundError);
    return cached;
  }

  const profile = await readPostgresProfile(userId);
  await saveProfileCache(profile);
  void checkForNewGames(userId).catch(reportBackgroundError);
  return profile;
}

export async function checkForNewGames(userId: string): Promise<NewGamesResponse> {
  if (!userId.trim()) throw new Error("A user ID is required to check for new games.");
  requireBrowser();

  const response = await fetch("/api/profile-cache/check", { cache: "no-store" });
  if (!response.ok) throw await responseError(response, "Could not check for new Lichess games.");
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    payload.userId !== userId ||
    typeof payload.newGamesCount !== "number" ||
    !Number.isInteger(payload.newGamesCount) ||
    payload.newGamesCount < 0 ||
    typeof payload.capped !== "boolean" ||
    (payload.lastGameTimestamp !== null && typeof payload.lastGameTimestamp !== "number")
  ) {
    throw new Error("New-games check returned an invalid response.");
  }
  const result = payload as NewGamesResponse;
  const cached = await readProfileCache(userId);
  if (cached) {
    await saveProfileCache({ ...cached, pendingNewGamesCount: result.newGamesCount });
  }
  window.dispatchEvent(new CustomEvent(PROFILE_CACHE_REFRESH_EVENT, { detail: result }));
  return result;
}

function toParsedGame(game: DashboardGame): ParsedGame {
  if (!Array.isArray(game.moves)) throw new Error(`Moves were not included for game ${game.lichessGameId}.`);
  if (game.playerColor !== "white" && game.playerColor !== "black") {
    throw new Error(`Game ${game.lichessGameId} has an invalid player color.`);
  }
  return {
    id: game.lichessGameId,
    playerColor: game.playerColor,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    moves: game.moves,
    clocks: game.clocks ?? null,
    clockInitialSec: game.clockInitialSec ?? null,
    clockIncrementSec: game.clockIncrementSec ?? null,
    openingName: game.openingName,
    openingEco: game.openingEco,
    result: game.result === "win" || game.result === "loss" ? game.result : "draw",
    rated: game.rated,
    speed: game.speed,
    createdAt: game.createdAt ? Date.parse(String(game.createdAt)) : null,
  };
}

async function fetchAllSavedGames(): Promise<DashboardGame[]> {
  const firstResponse = await fetch("/api/dashboard/games?page=1&includeMoves=true", { cache: "no-store" });
  if (!firstResponse.ok) throw await responseError(firstResponse, "Could not load saved games for analysis.");
  const firstPage = await firstResponse.json() as DashboardGamesData;
  const games = [...firstPage.games];

  for (let page = 2; page <= firstPage.totalPages; page++) {
    const response = await fetch(`/api/dashboard/games?page=${page}&includeMoves=true`, { cache: "no-store" });
    if (!response.ok) throw await responseError(response, `Could not load saved games page ${page}.`);
    const result = await response.json() as DashboardGamesData;
    games.push(...result.games);
  }
  if (games.length !== firstPage.totalGames) {
    throw new Error(`Expected ${firstPage.totalGames} saved games, but loaded ${games.length}.`);
  }
  return games;
}

async function pushEvaluation(
  gameId: string,
  gameEval: GameEval,
  moveFeatures: MoveFeature[],
  flags: FlaggedMove[],
  playerProfile: PlayerProfile,
): Promise<void> {
  const response = await fetch("/api/eval/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, gameEval, moveFeatures, flags, playerProfile }),
  });
  if (!response.ok) throw await responseError(response, `Could not persist analysis for game ${gameId}.`);
}

/**
 * Imports the complete Lichess history in bounded API batches, evaluates
 * unevaluated saved games at depth 16, persists each result to Postgres, then
 * refreshes the local speed cache from the authoritative database.
 */
export async function syncProfile(userId: string): Promise<UserProfileCache> {
  if (!userId.trim()) throw new Error("A user ID is required to sync a profile.");
  requireBrowser();
  const account = await signedInAccount();
  if (account.userId !== userId) throw new Error("The requested profile does not match the signed-in account.");

  let backfillComplete = false;
  while (!backfillComplete) {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    if (!response.ok) throw await responseError(response, "Could not sync Lichess games.");
    const result: unknown = await response.json();
    if (!isRecord(result) || typeof result.historyBackfillComplete !== "boolean") {
      throw new Error("Lichess sync returned an invalid response.");
    }
    backfillComplete = result.historyBackfillComplete;
  }

  const { extractAllMoveFeatures, buildPlayerProfile, extractMoveFeatures } =
    await import("@/lib/features/extractFeatures");
  const { evalGame } = await import("@/lib/eval/evalCache");
  const { flagMoves } = await import("@/lib/flags/flagEngine");
  const savedGames = await fetchAllSavedGames();
  const games = savedGames.map(toParsedGame);
  const allFeatures = extractAllMoveFeatures(games);
  const playerProfile = buildPlayerProfile(account.username, games, allFeatures);
  const emptyProfile: PlayerProfile = games.length > 0
    ? playerProfile
    : {
        username: "",
        gamesAnalyzed: 0,
        avgMoveTimeSecByPhase: { opening: null, middlegame: null, endgame: null },
        premoveRate: 0,
        mostCommonOpenings: [],
        avgOpponentRating: null,
      };
  const emptyWeaknessProfile: WeaknessProfile = {
    username: "",
    patterns: [],
    evaluatedGameIds: [],
    gamesEvaluated: 0,
    gamesFetched: games.length,
    confidence: "low",
    builtAt: Date.now(),
  };

  for (const [index, savedGame] of savedGames.entries()) {
    if (savedGame.evaluationDepth16) continue;
    const game = games[index];
    if (!game) throw new Error(`Saved game ${savedGame.lichessGameId} was not parsed.`);
    const gameEval = await evalGame(game.id, game.moves);
    if (gameEval.engineVersion !== PROFILE_SYNC_ENGINE_VERSION ||
        gameEval.points.length !== game.moves.length ||
        gameEval.points.some((point) => !Number.isFinite(point.depth) || point.depth < 16)) {
      throw new Error(`Game ${game.id} did not receive complete depth-16 analysis.`);
    }
    const moveFeatures = extractMoveFeatures(game);
    const flags = flagMoves(moveFeatures, emptyProfile, emptyWeaknessProfile, gameEval, game.playerColor);
    await pushEvaluation(game.id, gameEval, moveFeatures, flags, playerProfile);
  }

  const profile = await readPostgresProfile(userId);
  await saveProfileCache(profile);
  return profile;
}

async function signedInAccount(): Promise<{ userId: string; username: string }> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  if (!response.ok) throw await responseError(response, "Could not read the signed-in Lichess account.");
  const session: unknown = await response.json();
  if (
    !isRecord(session) ||
    !isRecord(session.user) ||
    typeof session.user.id !== "string" ||
    typeof session.user.name !== "string"
  ) {
    throw new Error("The signed-in Lichess account is unavailable.");
  }
  return { userId: session.user.id, username: session.user.name };
}

export function connectLichess(callbackUrl = "/dashboard") {
  return signIn("lichess", { callbackUrl });
}

export async function analyzePgn(pgnText: string): Promise<PgnSessionResult> {
  if (!pgnText.trim()) throw new Error("Paste a PGN game to analyze.");
  requireBrowser();

  const chess = new Chess();
  try {
    chess.loadPgn(pgnText, { strict: false });
  } catch (error) {
    throw new Error(`Could not parse PGN: ${error instanceof Error ? error.message : String(error)}`);
  }
  const moves = chess.history();
  if (moves.length === 0) throw new Error("The PGN contains no playable moves.");
  const headers = Object.fromEntries(
    Object.entries(chess.getHeaders()).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const result = headers.Result === "1-0" ? "win" : headers.Result === "0-1" ? "loss" : "draw";
  const id = `pgn-${crypto.randomUUID()}`;
  const parsedGame: ParsedGame = {
    id,
    playerColor: "white",
    opponentUsername: "PGN opponent",
    opponentRating: null,
    playerRating: null,
    moves,
    clocks: null,
    openingName: null,
    openingEco: null,
    result,
    rated: false,
    speed: null,
    createdAt: null,
  };
  const { extractMoveFeatures } = await import("@/lib/features/extractFeatures");
  const { evaluateMoveSequence } = await import("@/lib/eval/evalCache");
  const { evalFen } = await import("@/lib/eval/stockfishEngine");
  const { flagMoves } = await import("@/lib/flags/flagEngine");
  const moveFeatures = extractMoveFeatures(parsedGame);
  if (moveFeatures.length !== moves.length) throw new Error("The PGN contains an invalid or incomplete move sequence.");
  const gameEval: GameEval = {
    gameId: id,
    points: await evaluateMoveSequence(moves, evalFen),
    evaluatedAt: Date.now(),
    engineVersion: PROFILE_SYNC_ENGINE_VERSION,
  };
  if (
    gameEval.points.length !== moves.length ||
    gameEval.points.some((point) => !Number.isFinite(point.depth) || point.depth < 16)
  ) {
    throw new Error("Stockfish did not complete every PGN position at depth 16.");
  }

  const neutralProfile: PlayerProfile = {
    username: "PGN",
    gamesAnalyzed: 1,
    avgMoveTimeSecByPhase: { opening: null, middlegame: null, endgame: null },
    premoveRate: 0,
    mostCommonOpenings: [],
    avgOpponentRating: null,
  };
  const neutralWeakness: WeaknessProfile = {
    username: "PGN",
    patterns: [],
    evaluatedGameIds: [],
    gamesEvaluated: 0,
    gamesFetched: 1,
    confidence: "low",
    builtAt: Date.now(),
  };
  const flaggedMoments = (["white", "black"] as const).flatMap((color) =>
    flagMoves(moveFeatures, neutralProfile, neutralWeakness, gameEval, color),
  );
  const sessionResult: PgnSessionResult = {
    version: 1,
    id,
    pgn: pgnText,
    headers,
    moves,
    gameEval,
    flaggedMoments,
    analyzedAt: Date.now(),
  };
  savePgnSession(sessionResult);
  return sessionResult;
}

export function savePgnSession(result: PgnSessionResult): void {
  requireBrowser();
  window.sessionStorage.setItem(PGN_SESSION_KEY, JSON.stringify(result));
}

export function loadPgnSession(): PgnSessionResult | null {
  requireBrowser();
  const stored = window.sessionStorage.getItem(PGN_SESSION_KEY);
  if (stored === null) return null;
  const parsed: unknown = JSON.parse(stored);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.id !== "string" ||
    typeof parsed.pgn !== "string" ||
    !Array.isArray(parsed.moves) ||
    !isRecord(parsed.gameEval) ||
    !Array.isArray(parsed.flaggedMoments) ||
    typeof parsed.analyzedAt !== "number"
  ) {
    throw new Error("The saved PGN session has an invalid shape.");
  }
  return parsed as unknown as PgnSessionResult;
}
