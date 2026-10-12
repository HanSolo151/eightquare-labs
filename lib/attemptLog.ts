

export interface AttemptLogEntry {
  gameId: string;
  ply: number;
  flagSan: string;
  flagTimeSpentSec: number;
  replaySan: string | null;
  replayTimeSec: number | null;
  outcome: string;
  loggedAt: number; // epoch ms
}

const KEY_PREFIX = "verdict-attempts:";

// Same try/catch-everything, SSR-safe pattern as dismissals.ts / opponentCache.ts.
// Difference: this one appends to a growing list rather than overwriting a single blob.

export function loadAttempts(username: string): AttemptLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_PREFIX + username);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendAttempt(username: string, entry: AttemptLogEntry): void {
  if (typeof window === "undefined") return;
  try {
    const existing = loadAttempts(username);
    existing.push(entry);
    localStorage.setItem(KEY_PREFIX + username, JSON.stringify(existing));
  } catch {
    // storage full/disabled — attempt just doesn't persist this session, same
    // failure mode as every other localStorage helper in this project
  }
}