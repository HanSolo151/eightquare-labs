// Dismissal persistence for verdict cards.
// Key format in localStorage: "verdict-dismissed:<username>" -> string[] of dismissal ids.
// Legacy "<gameId>:<ply>" ids still dismiss every flag type at that ply;
// current "<gameId>:<ply>:<flagType>" ids dismiss only that specific flag.
// Namespaced per username so switching accounts doesn't carry over dismissals.

import type { FlagType } from "@/types";

function storageKey(username: string): string {
  return `verdict-dismissed:${username}`;
}

export function dismissalId(gameId: string, ply: number, flagType: FlagType): string {
	return `${gameId}:${ply}:${flagType}`;
}

function legacyDismissalId(gameId: string, ply: number): string {
	return `${gameId}:${ply}`;
}

/** Check current and legacy dismissal ids for a flag. */
export function isDismissed(dismissed: Set<string>, gameId: string, ply: number, flagType: FlagType): boolean {
	return dismissed.has(dismissalId(gameId, ply, flagType)) || dismissed.has(legacyDismissalId(gameId, ply));
}

export function loadDismissed(username: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(username));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch {
    // Corrupted or inaccessible localStorage — fail safe to "nothing dismissed"
    // rather than throwing and breaking the panel.
    return new Set();
  }
}

export function saveDismissed(username: string, dismissed: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(username), JSON.stringify(Array.from(dismissed)));
  } catch {
    // Storage full or disabled — dismissal just won't persist this session.
    // Not surfaced to the user; it's a non-critical convenience feature.
  }
}
