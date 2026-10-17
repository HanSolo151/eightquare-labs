import { buildOpponentPieceActivityProfile } from "./opponentPieceActivity";
import { buildOpponentOpeningTree } from "./opponentOpeningTree";
import { buildOpponentTimePressureProfile } from "./opponentTimePressure";
import type { OpeningTree, OpponentTimePressureProfile, PieceActivityProfile } from "@/types";

export interface OpponentMimicProfiles {
  pieceActivity: PieceActivityProfile | null;
  openingTree: OpeningTree | null;
  timePressure: OpponentTimePressureProfile | null;
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
    let pieceActivity: PieceActivityProfile | null = null;
    let openingTree: OpeningTree | null = null;
    let timePressure: OpponentTimePressureProfile | null = null;
    const unavailable: string[] = [];

    // These builders may fetch the same recent games. Keep them sequential
    // to respect Lichess rate limits; their persistent caches absorb repeats.
    try {
      pieceActivity = await buildOpponentPieceActivityProfile(username);
    } catch (err) {
      console.error("Could not build opponent piece-activity profile:", err);
      unavailable.push("piece-activity");
    }
    try {
      openingTree = await buildOpponentOpeningTree(username);
    } catch (err) {
      console.error("Could not build opponent opening tree:", err);
      unavailable.push("opening");
    }
    try {
      timePressure = await buildOpponentTimePressureProfile(username);
    } catch (err) {
      console.error("Could not build opponent time-pressure profile:", err);
      unavailable.push("time-pressure");
    }

    return {
      pieceActivity,
      openingTree,
      timePressure,
      notice: unavailable.length
        ? `${unavailable.join(", ")} profile${unavailable.length === 1 ? " is" : "s are"} unavailable; Maia will use the other available mimic signals.`
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
