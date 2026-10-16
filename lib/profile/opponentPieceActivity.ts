import { fetchGames, LichessFetchError } from "../lichess/fetchGames";
import { parseGames } from "../lichess/parseGame";
import { extractMoveFeatures } from "../features/extractFeatures";
import { evalGame } from "../eval/evalCache";
import { emptyPieceActivityProfile, updatePieceActivityProfile } from "./pieceActivityProfile";
import { getPieceActivityProfile, savePieceActivityProfile } from "./pieceActivityProfileCache";
import type { PieceActivityProfile, ParsedGame } from "@/types";

const MAX_OPPONENT_GAMES = 20;

export async function buildOpponentPieceActivityProfile(
  opponentUsername: string,
  onProgress?: (done: number, total: number) => void,
  // Allows callers such as efficacy harnesses to provide a split build set.
  providedGames?: ParsedGame[]
): Promise<PieceActivityProfile> {
  const cached = await getPieceActivityProfile(opponentUsername);
  const profile = cached ?? emptyPieceActivityProfile(opponentUsername);
  let games: ParsedGame[];
  if (providedGames) {
    games = providedGames;
  } else {
    let raw: Awaited<ReturnType<typeof fetchGames>>;
    try {
      raw = await fetchGames({ username: opponentUsername, max: MAX_OPPONENT_GAMES, rated: true, perfType: "rapid" });
    } catch (err) {
      if (err instanceof LichessFetchError && err.isNotFound) {
        await savePieceActivityProfile(profile);
        return profile;
      }
      throw err;
    }
    games = parseGames(raw, opponentUsername);
  }
  const toEvaluate = games.filter((game) => !profile.evaluatedGameIds.includes(game.id));

  for (let i = 0; i < toEvaluate.length; i++) {
    const game = toEvaluate[i];
    try {
      const gameEval = await evalGame(game.id, game.moves);
      const moveFeatures = extractMoveFeatures(game);
      updatePieceActivityProfile(profile, game.id, game.moves, gameEval, moveFeatures, game.playerColor);
    } catch (err) {
      console.error("Skipping opponent game in piece-activity eval:", game.id, err);
    }
    onProgress?.(i + 1, toEvaluate.length);
  }

  await savePieceActivityProfile(profile);
  return profile;
}
