import { Chess } from "chess.js";
import type { ParsedGame } from "@/types";

export interface OpponentProfile {
  aggression: number;
  sacrifice: number;
  pragmatism: number;
  theory: number;
  gamesAnalyzed: number;
  movesAnalyzed: number;
}

const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Derive coarse style rates from a corpus of the opponent's own games. */
export function buildOpponentProfile(games: ParsedGame[]): OpponentProfile {
  let gamesAnalyzed = 0;
  let movesAnalyzed = 0;
  let aggression = 0;
  let sacrifices = 0;
  let pragmatism = 0;
  let theory = 0;

  for (const game of games) {
    const chess = new Chess();
    let gameHadAnalyzedMove = false;
    for (let ply = 0; ply < game.moves.length; ply++) {
      const before = chess.board();
      const ownMove = (ply % 2 === 0 ? "white" : "black") === game.playerColor;
      let move;
      try { move = chess.move(game.moves[ply]); } catch { break; }
      if (!ownMove || ply < 16) continue;
      gameHadAnalyzedMove = true;
      movesAnalyzed++;

      const isCheck = chess.isCheck();
      const isCapture = !!move.captured;
      const enemyColor = game.playerColor === "white" ? "b" : "w";
      const enemyKing = chess.board().flat().find((piece) => piece?.color === enemyColor && piece.type === "k");
      const kingSquare = enemyKing ? chess.findPiece({ type: "k", color: enemyColor })[0] : null;
      const distanceToKing = (square: string | null) => {
        if (!square || !kingSquare) return Infinity;
        return Math.max(Math.abs("abcdefgh".indexOf(square[0]) - "abcdefgh".indexOf(kingSquare[0])), Math.abs(Number(square[1]) - Number(kingSquare[1])));
      };
      const advancesTowardKing = move.piece === "p" && distanceToKing(move.to) < distanceToKing(move.from);
      aggression += (isCheck ? 1 : 0) + (advancesTowardKing ? 0.35 : 0) + (isCapture ? 0.2 : 0);

      const ownColor = game.playerColor === "white" ? "w" : "b";
      const materialBalanceBefore = before.flat().reduce((s, p) => s + (p ? (p.color === ownColor ? 1 : -1) * (VALUES[p.type] ?? 0) : 0), 0);
      // A move can create an immediate sacrifice only when it leaves the
      // moved piece capturable and gives a forcing threat in return.
      const reply = new Chess(chess.fen());
      const opponentCanTakeMovedPiece = reply.moves({ verbose: true }).some((replyMove) => replyMove.to === move.to && !!replyMove.captured);
      const givesCounterThreat = isCheck || reply.moves({ verbose: true }).length <= 3;
      if (opponentCanTakeMovedPiece && givesCounterThreat && (VALUES[move.piece] ?? 0) >= 3) sacrifices++;

      const queensBefore = before.flat().filter(p => p?.type === "q").length;
      const queensAfter = chess.board().flat().filter(p => p?.type === "q").length;
      if (isCapture && queensAfter < queensBefore && materialBalanceBefore > 0) pragmatism++;
      const forcing = isCheck || isCapture || chess.moves().length <= 3;
      if (!forcing) theory++;
    }
    if (gameHadAnalyzedMove) gamesAnalyzed++;
  }

  const denominator = Math.max(1, movesAnalyzed);
  return {
    aggression: clamp(aggression / denominator),
    sacrifice: clamp(sacrifices / denominator),
    pragmatism: clamp(pragmatism / denominator),
    theory: clamp(theory / denominator),
    gamesAnalyzed,
    movesAnalyzed,
  };
}
