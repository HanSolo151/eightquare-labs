import { Chess, type Square } from "chess.js";
import type { ParsedGame } from "@/types";
import { mirrorFen, mirrorUci } from "./boardToTensor";

export const STYLE_VECTOR_FEATURES = [
  "aggression_rate",
  "material_loss_proxy",
  "trade_willingness",
  "kingside_pawn_storm_rate",
  "piece_mobility",
  "king_safety",
] as const;

export const STYLE_VECTOR_DIMENSION = STYLE_VECTOR_FEATURES.length;
export const STYLE_VECTOR_MINIMUM_PLY = 16;
const MATERIAL_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

interface PlayerPosition {
  fen: string;
  materialAfterOwnMove: number;
}

function materialBalance(chess: Chess): number {
  let balance = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = MATERIAL_VALUE[piece.type] ?? 0;
      balance += piece.color === "w" ? value : -value;
    }
  }
  return balance;
}

function canonicalPosition(
  fen: string,
  uci: string,
  playerColor: ParsedGame["playerColor"],
): { chess: Chess; uci: string } {
  const isBlack = playerColor === "black";
  const canonicalFen = isBlack ? mirrorFen(fen) : fen;
  const canonicalUci = isBlack ? mirrorUci(uci) : uci;
  return { chess: new Chess(canonicalFen), uci: canonicalUci };
}

/**
 * Summarizes only a player's moves at or after ply 16. The material-loss
 * component is a PGN-only proxy, not an engine-verified sacrifice measure.
 */
export function calculateStyleVector(
  games: Pick<ParsedGame, "moves" | "playerColor">[],
): number[] | null {
  const totals = {
    moves: 0,
    aggressive: 0,
    aheadMoves: 0,
    aheadCaptures: 0,
    pawnStorm: 0,
    pieceMobility: 0,
    safePositions: 0,
    materialLossOpportunities: 0,
    materialLosses: 0,
  };

  for (const game of games) {
    const board = new Chess();
    const playerTurn = game.playerColor === "white" ? "w" : "b";
    const positions: PlayerPosition[] = [];

    for (let ply = 0; ply < game.moves.length; ply++) {
      const san = game.moves[ply];
      if (san === undefined) continue;
      const beforeFen = board.fen();
      const isPlayerMove = board.turn() === playerTurn;

      if (!isPlayerMove) {
        board.move(san);
        continue;
      }

      const playedMove = board.move(san);
      if (ply < STYLE_VECTOR_MINIMUM_PLY) continue;

      const playedUci = `${playedMove.from}${playedMove.to}${playedMove.promotion ?? ""}`;
      const { chess: positionBeforeMove, uci } = canonicalPosition(
        beforeFen,
        playedUci,
        game.playerColor,
      );
      const materialBefore = materialBalance(positionBeforeMove);
      const ahead = materialBefore > 0;
      const checkedBefore = positionBeforeMove.isCheck();
      const nonPawnPieces = positionBeforeMove
        .board()
        .flat()
        .filter((piece) => piece?.color === "w" && piece.type !== "p").length;
      const activeMoves = positionBeforeMove
        .moves({ verbose: true })
        .filter((candidate) => {
          const piece = positionBeforeMove.get(candidate.from);
          return piece?.color === "w" && piece.type !== "p";
        }).length;
      const positionAfterOwnMove = new Chess(positionBeforeMove.fen());
      const move = positionAfterOwnMove.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4],
      });
      if (!move) throw new Error(`Could not replay canonical move ${uci}.`);

      totals.moves++;
      totals.aggressive += Number(
        move.captured !== undefined || positionAfterOwnMove.isCheck(),
      );
      totals.aheadMoves += Number(ahead);
      totals.aheadCaptures += Number(ahead && move.captured !== undefined);
      totals.pawnStorm += Number(
        move.piece === "p" &&
          ["f", "g", "h"].includes(move.to[0] ?? "") &&
          Number(move.to[1]) >= 4,
      );
      totals.pieceMobility += nonPawnPieces
        ? Math.min(1, activeMoves / (nonPawnPieces * 8))
        : 0;
      totals.safePositions += Number(!checkedBefore);
      positions.push({
        fen: positionBeforeMove.fen(),
        materialAfterOwnMove: materialBalance(positionAfterOwnMove),
      });
    }

    for (let index = 0; index + 1 < positions.length; index++) {
      const current = positions[index];
      const next = positions[index + 1];
      if (!current || !next) continue;
      totals.materialLossOpportunities++;
      const materialAfterReply = materialBalance(new Chess(next.fen));
      totals.materialLosses += Number(
        current.materialAfterOwnMove - materialAfterReply >= 1,
      );
    }
  }

  if (!totals.moves) return null;
  return [
    totals.aggressive / totals.moves,
    totals.materialLossOpportunities
      ? totals.materialLosses / totals.materialLossOpportunities
      : 0,
    totals.aheadMoves ? totals.aheadCaptures / totals.aheadMoves : 0,
    totals.pawnStorm / totals.moves,
    totals.pieceMobility / totals.moves,
    totals.safePositions / totals.moves,
  ];
}
