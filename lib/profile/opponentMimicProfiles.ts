import { buildOpponentOpeningTree } from "./opponentOpeningTree";
import type { OpeningTree } from "@/types";

export interface OpponentMimicProfiles {
  openingTree: OpeningTree | null;
  notice: string | null;
}

// One in-flight/build promise per account name. The game viewer and its
// spar panel can both request these profiles without racing duplicate
// Stockfish work or issuing parallel Lichess history requests.
const profileLoads = new Map<string, Promise<OpponentMimicProfiles>>();

export function loadOpponentMimicProfiles(username: string): Promise<OpponentMimicProfiles> {
  const key = username.trim().toLowerCase();
  const existing = profileLoads.get(key);
  if (existing) return existing;

  const loading = (async (): Promise<OpponentMimicProfiles> => {
    let openingTree: OpeningTree | null = null;
    const unavailable: string[] = [];

    // Keep public history requests sequential to respect Lichess rate limits.
    // Do not build the piece-activity/Stockfish profile here: current move
    // ranking does not use piece-use frequencies as evidence of preferences.
    try {
      openingTree = await buildOpponentOpeningTree(username);
    } catch (err) {
      console.error("Could not build opponent opening tree:", err);
      unavailable.push("opening");
    }
    return {
      openingTree,
      notice: unavailable.length
        ? `${unavailable.includes("opening") ? "Opponent opening history is unavailable" : "Opponent data is unavailable"}; rating-conditioned Maia will be used.`
        : null,
    };
  })();

  profileLoads.set(key, loading);
  if (profileLoads.size > 50) {
    const oldestKey = profileLoads.keys().next().value;
    if (oldestKey) profileLoads.delete(oldestKey);
  }
  return loading;
}
