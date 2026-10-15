import type { ParsedGame, MoveFeature } from "@/types";
import { evalGame, getCachedEval } from "../eval/evalCache";
import { getProfile, saveProfile, emptyProfile } from "../profile/profileCache";
import { updateWeaknessProfile } from "../profile/weaknessProfile";
import { extractMoveFeatures } from "../features/extractFeatures";

export type EvalProgress = { done: number; total: number; currentGameId: string | null };
let evaluationBatchQueue: Promise<void> = Promise.resolve();
const GAMES_IN_FLIGHT = 2;

/**
 * Evaluates games in small batches matched to the Stockfish worker pool,
 * folding results into the persisted weakness profile in order. Safe to call
 * every session: already-evaluated games are skipped via the cache.
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

  let completed = 0;
  for (let start = 0; start < games.length; start += GAMES_IN_FLIGHT) {
    const batch = games.slice(start, start + GAMES_IN_FLIGHT);
    const evaluatedBatch = await Promise.all(
      batch.map(async (game) => {
        onProgress?.({ done: completed, total: games.length, currentGameId: game.id });
        const cached = await getCachedEval(game.id, game.moves.length);
        return {
          game,
          gameEval: cached ?? await evalGame(game.id, game.moves),
        };
      })
    );

    // Keep profile writes sequential; IndexedDB profile updates must not race.
    for (const { game, gameEval } of evaluatedBatch) {
      completed++;
      if (!profile.evaluatedGameIds.includes(game.id)) {
        const moveFeatures: MoveFeature[] = extractMoveFeatures(game);
        profile = updateWeaknessProfile(profile, game.id, gameEval, moveFeatures, game.playerColor);
        await saveProfile(profile); // persist incrementally, not just at the end
      }
      onProgress?.({ done: completed, total: games.length, currentGameId: game.id });
    }
  }

  onProgress?.({ done: games.length, total: games.length, currentGameId: null });
}