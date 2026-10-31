import { Chess } from "chess.js";
import { loadMoveVocab } from "./moveVocab";
import { mirrorUci } from "./boardToTensor";

/** Maia's highest-logit legal move, with no opponent-specific adjustment. */
export async function selectTopLegalMaiaMove(fen: string, logitsMaia: Float32Array): Promise<string | null> {
  const vocabulary = await loadMoveVocab();
  if (logitsMaia.length !== vocabulary.length) {
    throw new Error(`Maia logits (${logitsMaia.length}) do not match move vocabulary (${vocabulary.length}).`);
  }
  const vocabularyIndex = new Map(vocabulary.map((uci, index) => [uci, index]));
  const chess = new Chess(fen);
  const mirror = chess.turn() === "b";
  let bestMove: string | null = null;
  let bestLogit = -Infinity;
  for (const move of chess.moves({ verbose: true })) {
    const uci = move.from + move.to + (move.promotion ?? "");
    const index = vocabularyIndex.get(mirror ? mirrorUci(uci) : uci);
    if (index === undefined || !Number.isFinite(logitsMaia[index])) continue;
    if (logitsMaia[index] > bestLogit) {
      bestLogit = logitsMaia[index];
      bestMove = uci;
    }
  }
  return bestMove;
}
