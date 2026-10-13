import type { ParsedGame, MoveFeature } from "@/types";
import { evalGame, getCachedEval } from "../eval/evalCache";
import { getProfile, saveProfile, emptyProfile } from "../profile/profileCache";
import { updateWeaknessProfile } from "../profile/weaknessProfile";
import { extractMoveFeatures } from "../features/extractFeatures";

export type EvalProgress = { done: number; total: number; currentGameId: string | null };
let evaluationBatchQueue: Promise<void> = Promise.resolve();

/**
 * Evaluates every not-yet-cached game for this player, one at a time
 * (Stockfish is a single worker instance — no point parallelizing against
 * one engine), folding each into the persisted weakness profile as it
 * finishes. Safe to call every session: already-evaluated games are skipped
 * via the cache, so a returning player only pays for their new games.
 *
 * Saves the profile after EVERY game, not just at the end — if the tab
 * closes mid-batch, progress already made is not lost.
 */
export function runBackgroundEval(
  username: string,
  games: ParsedGame[],
  onProgress?: (p: EvalProgress) => void
): Promise<void> {
  const result = evaluationBatchQueue.then(() => runEvaluationBatch(username, games, onProgress));
  evaluationBatchQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function runEvaluationBatch(
  username: string,
  games: ParsedGame[],
  onProgress?: (p: EvalProgress) => void
): Promise<void> {
  let profile = (await getProfile(username)) ?? emptyProfile(username);
  if (!Array.isArray(profile.evaluatedGameIds)) {
    // Rebuild legacy profile state from cached evaluations so we don't count
    // old phase-only patterns twice or silently skip pattern extraction.
    profile = emptyProfile(username);
  }
  profile.gamesFetched = games.length;

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    let gameEval = await getCachedEval(game.id);
    if (!gameEval) {
      onProgress?.({ done: i, total: games.length, currentGameId: game.id });
      gameEval = await evalGame(game.id, game.moves);
    }
    if (profile.evaluatedGameIds.includes(game.id)) continue;

    const moveFeatures: MoveFeature[] = extractMoveFeatures(game);
    profile = updateWeaknessProfile(profile, game.id, gameEval, moveFeatures, game.playerColor);

    await saveProfile(profile); // persist incrementally, not just at the end
  }

  onProgress?.({ done: games.length, total: games.length, currentGameId: null });
}