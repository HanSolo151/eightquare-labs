import type { WeaknessProfile, GameEval, MoveFeature } from "@/types";

/**
 * Tracks evaluation coverage only. Phase labels alone are not a chess
 * weakness or tactical motif, so do not manufacture "patterns" from them.
 * This profile remains the compatibility/coverage record until there is a
 * defensible motif classifier and enough data to validate it.
 */
export function updateWeaknessProfile(
  profile: WeaknessProfile,
  gameId: string,
  gameEval: GameEval,
  moveFeatures: MoveFeature[],
  playerColor: "white" | "black"
): WeaknessProfile {
  profile.evaluatedGameIds ??= [];
  if (profile.evaluatedGameIds.includes(gameId)) return profile;

  // Keep the input contract while deliberately declining unsupported phase
  // buckets. These values may support a future motif classifier, but are not
  // evidence for repeating weaknesses by themselves.
  void gameEval;
  void moveFeatures;
  void playerColor;

  profile.evaluatedGameIds.push(gameId);
  profile.gamesEvaluated++;
  profile.confidence = profile.gamesEvaluated >= 15 ? "high" : profile.gamesEvaluated >= 5 ? "medium" : "low";
  profile.builtAt = Date.now();
  return profile;
}
