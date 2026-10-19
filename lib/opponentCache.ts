import type { OpponentFeatures } from "./lichess/opponentFeatures";

/**
 * Client-side localStorage cache for OpponentFeatures, same pattern as
 * lib/dismissals.ts from Step 6: try/catch everything, SSR-safe, silent
 * failure rather than throwing if storage is unavailable/full.
 *
 * Namespaced per account and opponent, separate key prefix from dismissals:
 * "opponent-features:<userId>:<username>".
 *
 * TTL exists because this is re-fetched from Lichess every time a verdict
 * card's opponent is expanded — without a cache, clicking the same
 * opponent's cards repeatedly would refetch their last 20 games every
 * time, which is wasteful and slow.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(userId: string, username: string): string {
  return `opponent-features:${userId}:${username.trim().toLowerCase()}`;
}

export function loadCachedOpponentFeatures(
  userId: string,
  username: string
): OpponentFeatures | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(userId, username));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OpponentFeatures;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    if (Date.now() - parsed.fetchedAt > TTL_MS) return null; // expired
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedOpponentFeatures(
  userId: string,
  username: string,
  features: OpponentFeatures
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(userId, username), JSON.stringify(features));
  } catch {
    // storage full/disabled — silently skip caching, matches dismissals.ts
  }
}
