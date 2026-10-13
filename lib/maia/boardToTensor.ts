import { Chess, type Square } from "chess.js";

// Mirrors utils.board_to_tensor() from Step 1, channel-for-channel.
// Output shape: Float32Array of length 18 * 8 * 8, channel-major (C, H, W).

const PIECE_CHANNEL: Record<string, number> = {
  // White: 0-5, Black: 6-11 — pawn, knight, bishop, rook, queen, king
  wp: 0, wn: 1, wb: 2, wr: 3, wq: 4, wk: 5,
  bp: 6, bn: 7, bb: 8, br: 9, bq: 10, bk: 11,
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** Mirrors ranks and swaps piece colors, matching python-chess Board.mirror(). */
export function mirrorFen(fen: string): string {
  const chess = new Chess(fen);
  const mirroredRanks = chess.board().slice().reverse().map((rank) => {
    let empty = 0;
    let encoded = "";
    for (const piece of rank) {
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) encoded += String(empty);
      empty = 0;
      const type = piece.type;
      encoded += piece.color === "w" ? type : type.toUpperCase();
    }
    if (empty) encoded += String(empty);
    return encoded;
  });

  const fields = chess.fen().split(" ");
  const castling = fields[2] ?? "-";
  const mirroredCastling = [
    castling.includes("k") ? "K" : "",
    castling.includes("q") ? "Q" : "",
    castling.includes("K") ? "k" : "",
    castling.includes("Q") ? "q" : "",
  ].join("") || "-";
  const epSquare = fields[3] && fields[3] !== "-"
    ? `${fields[3][0]}${9 - Number(fields[3][1])}`
    : "-";

  return [mirroredRanks.join("/"), chess.turn() === "w" ? "b" : "w", mirroredCastling, epSquare, fields[4], fields[5]].join(" ");
}

/** Mirrors a UCI move's rank coordinates, preserving promotion suffixes. */
export function mirrorUci(uci: string): string {
  if (uci.length < 4) return uci;
  const from = `${uci[0]}${9 - Number(uci[1])}`;
  const to = `${uci[2]}${9 - Number(uci[3])}`;
  return `${from}${to}${uci.slice(4)}`;
}

// function squareIndex(square: Square): { rank: number; file: number } {
//   const file = FILES.indexOf(square[0]);
//   const rank = 8 - parseInt(square[1], 10); // rank 8 -> row 0, rank 1 -> row 7
//   return { rank, file };
// }

function squareIndex(square: Square): { rank: number; file: number } {
  const file = FILES.indexOf(square[0]);
  const rank = parseInt(square[1], 10) - 1; // rank 1 -> row 0, rank 8 -> row 7 (matches Python's divmod(square, 8))
  return { rank, file };
}

export function boardToTensor(fen: string): Float32Array {
  const original = new Chess(fen);
  // Maia-2 trains/infer its active player as White: its official preprocessing
  // mirrors positions where Black is to move, then mirrors predicted moves back.
  const chess = original.turn() === "b" ? new Chess(mirrorFen(fen)) : original;
  const tensor = new Float32Array(18 * 8 * 8); // zero-initialized

  const set = (channel: number, rank: number, file: number, value = 1.0) => {
    tensor[channel * 64 + rank * 8 + file] = value;
  };

  // Channels 0-11: piece placement
  for (const file of FILES) {
    for (let rankNum = 1; rankNum <= 8; rankNum++) {
      const sq = `${file}${rankNum}` as Square;
      const piece = chess.get(sq);
      if (!piece) continue;
      const key = `${piece.color}${piece.type}`;
      const channel = PIECE_CHANNEL[key];
      const { rank, file: f } = squareIndex(sq);
      set(channel, rank, f);
    }
  }

  // Channel 12: side to move — entire plane 1.0 if White to move
  if (chess.turn() === "w") {
    for (let i = 0; i < 64; i++) tensor[12 * 64 + i] = 1.0;
  }

  // Channels 13-16: castling rights, entire plane each
  const fenParts = chess.fen().split(" ");
  const castling = fenParts[2] ?? "-";
  if (castling.includes("K")) for (let i = 0; i < 64; i++) tensor[13 * 64 + i] = 1.0;
  if (castling.includes("Q")) for (let i = 0; i < 64; i++) tensor[14 * 64 + i] = 1.0;
  if (castling.includes("k")) for (let i = 0; i < 64; i++) tensor[15 * 64 + i] = 1.0;
  if (castling.includes("q")) for (let i = 0; i < 64; i++) tensor[16 * 64 + i] = 1.0;

  // Channel 17: en passant target square, single square only
  const epSquare = fenParts[3];
  if (epSquare && epSquare !== "-") {
    const { rank, file } = squareIndex(epSquare as Square);
    set(17, rank, file);
  }

  return tensor;
}