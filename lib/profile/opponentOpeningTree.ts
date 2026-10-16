import { fetchGames, LichessFetchError } from "../lichess/fetchGames";
import { parseGames } from "../lichess/parseGame";
import { emptyOpeningTree, updateOpeningTree } from "./openingTree";
import { getOpeningTree, saveOpeningTree } from "./openingTreeCache";
import type { OpeningTree, ParsedGame } from "@/types";

const MAX_OPPONENT_GAMES = 20;

export async function buildOpponentOpeningTree(
  opponentUsername: string,
  onProgress?: (done: number, total: number) => void,
  providedGames?: ParsedGame[]
): Promise<OpeningTree> {
  const cached = await getOpeningTree(opponentUsername);
  const tree = cached ?? emptyOpeningTree(opponentUsername);
  let games: ParsedGame[];
  if (providedGames) {
    games = providedGames;
  } else {
    let raw: Awaited<ReturnType<typeof fetchGames>>;
    try {
      raw = await fetchGames({ username: opponentUsername, max: MAX_OPPONENT_GAMES, rated: true, perfType: "rapid" });
    } catch (err) {
      if (err instanceof LichessFetchError && err.isNotFound) return tree;
      throw err;
    }
    games = parseGames(raw, opponentUsername);
  }
  const toEvaluate = games.filter((game) => !tree.evaluatedGameIds.includes(game.id));
  for (let i = 0; i < toEvaluate.length; i++) {
    const game = toEvaluate[i];
    try {
      updateOpeningTree(tree, game.id, game.moves, game.playerColor);
    } catch (err) {
      console.error("Skipping opponent game in opening-tree build:", game.id, err);
    }
    onProgress?.(i + 1, toEvaluate.length);
  }
  await saveOpeningTree(tree);
  return tree;
}
