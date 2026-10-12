import type { ParsedGame, FlaggedMove } from "@/types";

export interface GameData {
  games: ParsedGame[];
  flagged: FlaggedMove[];
  warnings: string[];
}

interface CachedGameData extends GameData {
  fetchedAt: number;
}

/**
 * Caches the full /api/games response per-username, same try/catch +
 * SSR-safe pattern as opponentCache.ts (Step 8) and dismissals.ts (Step 6).
 *
 * TTL is 1 hour, NOT 24 like opponentCache.ts — an opponent's last-20-games
 * history barely shifts day to day, but the user's OWN game list can change
 * within the same session if they're actively playing. 1 hour is the
 * compromise between "skip the intake fetch" and "don't silently hide a
 * game you just finished for a full day."
 *
 * Cache is replaced wholesale on every fresh fetch, never merged — merging
 * flagged-move identity (gameId:ply) across pipeline re-runs risks subtle
 * staleness bugs if the extraction/flagging logic ever changes, and isn't
 * worth the complexity for v1.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(username: string): string {
  return `game-data:${username}`;
}

export function loadCachedGameData(username: string): CachedGameData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(username));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedGameData;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    return parsed; // caller decides whether it's stale (see isStale below) — we don't drop it here, since "stale but show it anyway with a Refresh option" is a valid use
  } catch {
    return null;
  }
}

export function isStale(cached: CachedGameData): boolean {
  return Date.now() - cached.fetchedAt > TTL_MS;
}

export function saveCachedGameData(username: string, data: GameData): void {
  if (typeof window === "undefined") return;
  try {
    const toStore: CachedGameData = { ...data, fetchedAt: Date.now() };
    window.localStorage.setItem(cacheKey(username), JSON.stringify(toStore));
  } catch {
    // storage full/disabled — silently skip, matches every other cache
  }
}