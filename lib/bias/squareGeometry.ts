// Pure square/rank/file/diagonal helpers. Kept independent from chess.js so
// coordinate calculations stay small and easy to verify.

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export type File = (typeof FILES)[number];

export interface SquareCoord {
  file: number; // 0-7, a-h
  rank: number; // 0-7, rank 1-8
}

export function parseSquare(square: string): SquareCoord | null {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  return { file: square.charCodeAt(0) - 97, rank: Number(square[1]) - 1 };
}

export function squareName({ file, rank }: SquareCoord): string {
  if (!Number.isInteger(file) || !Number.isInteger(rank) || file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new RangeError("Chess square coordinates must be integers from 0 to 7.");
  }
  return `${FILES[file]}${rank + 1}`;
}

/** file-rank, constant along the a1-h8 direction. Range -7..7. */
export function mainDiagonalKey({ file, rank }: SquareCoord): number {
  return file - rank;
}

/** file+rank, constant along the a8-h1 direction. Range 0..14. */
export function antiDiagonalKey({ file, rank }: SquareCoord): number {
  return file + rank;
}

export function mainDiagonalLabel(key: number): string {
  if (!Number.isInteger(key) || key < -7 || key > 7) throw new RangeError("Main diagonal key must be -7..7.");
  const start: SquareCoord = key >= 0 ? { file: key, rank: 0 } : { file: 0, rank: -key };
  const end: SquareCoord = key >= 0 ? { file: 7, rank: 7 - key } : { file: 7 + key, rank: 7 };
  return `${squareName(start)}-${squareName(end)}`;
}

export function antiDiagonalLabel(key: number): string {
  if (!Number.isInteger(key) || key < 0 || key > 14) throw new RangeError("Anti-diagonal key must be 0..14.");
  const start: SquareCoord = key <= 7 ? { file: 0, rank: key } : { file: key - 7, rank: 7 };
  const end: SquareCoord = key <= 7 ? { file: key, rank: 0 } : { file: 7, rank: key - 7 };
  return `${squareName(start)}-${squareName(end)}`;
}

export function allSquares(): string[] {
  return Array.from({ length: 64 }, (_, index) => squareName({ file: index % 8, rank: Math.floor(index / 8) }));
}
