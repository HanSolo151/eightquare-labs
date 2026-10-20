import { Chess } from "chess.js";
import type { OpeningTree } from "@/types";

export const OPENING_TREE_PLIES = 14;
export const MIN_OCCURRENCES = 3;
export const OPENING_BOOST_CAP = 3;

export function openingFenKey(fen: string): string {
  const [board, turn, castling] = fen.split(" ");
  return `${board} ${turn} ${castling ?? "-"}`;
}

export function emptyOpeningTree(username: string): OpeningTree {
  return { username, positions: {}, evaluatedGameIds: [], gamesEvaluated: 0, builtAt: Date.now() };
}

export function updateOpeningTree(
  tree: OpeningTree,
  gameId: string,
  moves: string[],
  opponentColor: "white" | "black"
): OpeningTree {
  tree.evaluatedGameIds ??= [];
  if (tree.evaluatedGameIds.includes(gameId)) return tree;
  const chess = new Chess();
  const plyLimit = Math.min(moves.length, OPENING_TREE_PLIES);
  for (let ply = 0; ply < plyLimit; ply++) {
    const moverColor = ply % 2 === 0 ? "white" : "black";
    const fenBefore = chess.fen();
    let move;
    try { move = chess.move(moves[ply]); } catch { break; }
    if (!move) break;
    if (moverColor !== opponentColor) continue;
    const key = openingFenKey(fenBefore);
    const uci = move.from + move.to + (move.promotion ?? "");
    const bucket = (tree.positions[key] ??= {});
    bucket[uci] = (bucket[uci] ?? 0) + 1;
  }
  tree.evaluatedGameIds.push(gameId);
  tree.gamesEvaluated++;
  tree.builtAt = Date.now();
  return tree;
}

export function openingBookPosition(
  tree: OpeningTree | null | undefined,
  fen: string
): { byUci: Record<string, number>; total: number } | null {
  if (!tree) return null;
  const byUci = tree.positions[openingFenKey(fen)];
  if (!byUci) return null;
  const total = Object.values(byUci).reduce((sum, count) => sum + count, 0);
  return total > 0 ? { byUci, total } : null;
}

export function openingBookEntryFor(
  tree: OpeningTree | null | undefined,
  fen: string,
  uci: string
): { matchCount: number; totalCount: number; boost: number } | null {
  const position = openingBookPosition(tree, fen);
  if (!position) return null;
  const matchCount = position.byUci[uci] ?? 0;
  if (matchCount < MIN_OCCURRENCES) return null;
  const boost = Math.min(OPENING_BOOST_CAP, 1 + (matchCount / position.total) * (OPENING_BOOST_CAP - 1));
  return { matchCount, totalCount: position.total, boost };
}

/** Total observed replies at a position, independent of move choice. */
export function openingTreeHitsAt(tree: OpeningTree | null | undefined, fen: string): number {
  return openingBookPosition(tree, fen)?.total ?? 0;
}
