import { Chess } from "chess.js";
import { toPlayerPerspective } from "@/lib/eval/toPlayerPerspective";
import type { GameEval, ParsedGame, PieceType } from "@/types";

const PIECE_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const MIN_SACRIFICED_MATERIAL_PAWNS = 1;
export const MAX_COMPENSATED_EVAL_LOSS_CP = 50;
export const MIN_BLUNDER_EVAL_LOSS_CP = 150;
export const MIN_SACRIFICE_EVAL_DEPTH = 8;

export type MaterialSacrificeOutcome = "compensated" | "blunder" | "uncertain";

export interface MaterialSacrificeEvidence {
  ply: number;
  materialLostPawns: number;
  evalLossCp: number;
  evalDepth: number;
  outcome: MaterialSacrificeOutcome;
}

/**
 * Detects material losses accepted by the opponent on the immediate reply,
 * then classifies them using the engine score before the offering move and
 * after that reply. Material alone never implies a good sacrifice. Mate-only
 * and shallow evaluations are skipped rather than translated into centipawns.
 */
export function detectMaterialSacrifices(
  game: Pick<ParsedGame, "id" | "moves" | "playerColor">,
  evaluation: GameEval,
): MaterialSacrificeEvidence[] {
  if (evaluation.gameId !== game.id) return [];

  const chess = new Chess();
  const fenBefore: string[] = [];
  const fenAfter: string[] = [];
  for (const san of game.moves) {
    fenBefore.push(chess.fen());
    try {
      const move = chess.move(san);
      if (!move) return [];
      fenAfter.push(chess.fen());
    } catch {
      return [];
    }
  }

  const evalByPly = new Map(evaluation.points.map((point) => [point.ply, point]));
  const evidence: MaterialSacrificeEvidence[] = [];
  for (let ply = 0; ply + 1 < game.moves.length; ply++) {
    const moverColor = ply % 2 === 0 ? "white" : "black";
    if (moverColor !== game.playerColor) continue;

    const beforeFen = fenBefore[ply];
    const afterReplyFen = fenAfter[ply + 1];
    if (!beforeFen || !afterReplyFen) continue;
    const materialLostPawns = materialBalance(new Chess(beforeFen), game.playerColor) -
      materialBalance(new Chess(afterReplyFen), game.playerColor);
    if (materialLostPawns < MIN_SACRIFICED_MATERIAL_PAWNS) continue;

    const candidate = evalByPly.get(ply);
    const reply = evalByPly.get(ply + 1);
    if (!candidate || !reply || candidate.depth < MIN_SACRIFICE_EVAL_DEPTH || reply.depth < MIN_SACRIFICE_EVAL_DEPTH) continue;
    if (candidate.cpBefore === null || candidate.mateBefore !== null ||
        reply.cpAfter === null || reply.mateAfter !== null ||
        !Number.isFinite(candidate.cpBefore) || !Number.isFinite(reply.cpAfter)) continue;

    const beforeForPlayer = toPlayerPerspective(candidate.cpBefore, ply, game.playerColor);
    const afterForPlayer = toPlayerPerspective(reply.cpAfter, ply + 1, game.playerColor);
    const evalLossCp = beforeForPlayer - afterForPlayer;
    const outcome: MaterialSacrificeOutcome = evalLossCp <= MAX_COMPENSATED_EVAL_LOSS_CP
      ? "compensated"
      : evalLossCp >= MIN_BLUNDER_EVAL_LOSS_CP
        ? "blunder"
        : "uncertain";
    evidence.push({
      ply,
      materialLostPawns,
      evalLossCp,
      evalDepth: Math.min(candidate.depth, reply.depth),
      outcome,
    });
  }
  return evidence;
}

function materialBalance(chess: Chess, playerColor: ParsedGame["playerColor"]): number {
  let white = 0;
  let black = 0;
  for (const row of chess.board()) for (const piece of row) {
    if (!piece) continue;
    const value = PIECE_VALUE[piece.type];
    if (piece.color === "w") white += value;
    else black += value;
  }
  return playerColor === "white" ? white - black : black - white;
}
