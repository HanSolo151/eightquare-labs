/**
 * Remembers the last username used, separately from gameDataCache.ts.
 * This is what lets the UsernameForm be skipped on load — it's deliberately
 * NOT namespaced (there's only ever one "last" username) and has no TTL,
 * since remembering who you are doesn't go stale the way game data does.
 */

const KEY = "last-username";

export function loadLastUsername(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveLastUsername(username: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, username);
  } catch {
    // storage full/disabled — silently skip, matches every other cache in this project
  }
}

export function clearLastUsername(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}