/** Shared centipawn equivalent used when Stockfish reports a forced mate. */
export const MATE_EQUIVALENT_CP = 10_000;

/** Convert an EvalPoint score from the mover's POV to the account player's POV. */
export function toPlayerPerspective(score: number, ply: number, playerColor: "white" | "black"): number {
  const moverColor = ply % 2 === 0 ? "white" : "black";
  return moverColor === playerColor ? score : -score;
}
