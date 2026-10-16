import { Chess } from "chess.js";
import type { GameEval, MoveFeature, PieceActivityProfile, PieceType } from "@/types";

function pieceTypeFromSan(san: string): PieceType {
  switch (san[0]) {
    case "O": return "k";
    case "N": return "n";
    case "B": return "b";
    case "R": return "r";
    case "Q": return "q";
    case "K": return "k";
    default: return "p";
  }
}

function emptyPhaseBucket() {
  return { moveCount: 0, tradeInitiatedCount: 0, engineTopMatchCount: 0 };
}

function emptyPieceBucket() {
  return { opening: emptyPhaseBucket(), middlegame: emptyPhaseBucket(), endgame: emptyPhaseBucket() };
}

export function emptyPieceActivityProfile(username: string): PieceActivityProfile {
  return {
    username,
    byPieceType: { p: emptyPieceBucket(), n: emptyPieceBucket(), b: emptyPieceBucket(), r: emptyPieceBucket(), q: emptyPieceBucket(), k: emptyPieceBucket() },
    evaluatedGameIds: [],
    gamesEvaluated: 0,
    confidence: "low",
    builtAt: Date.now(),
  };
}

export function updatePieceActivityProfile(
  profile: PieceActivityProfile,
  gameId: string,
  moves: string[],
  gameEval: GameEval,
  moveFeatures: MoveFeature[],
  playerColor: "white" | "black"
): PieceActivityProfile {
  profile.evaluatedGameIds ??= [];
  if (profile.evaluatedGameIds.includes(gameId)) return profile;
  const features = new Map(moveFeatures.map((feature) => [feature.ply, feature]));
  const points = new Map(gameEval.points.map((point) => [point.ply, point]));
  const chess = new Chess();
  for (let ply = 0; ply < moves.length; ply++) {
    const fenBefore = chess.fen();
    let move;
    try { move = chess.move(moves[ply]); } catch { break; }
    if (!move) break;
    const feature = features.get(ply);
    if (!feature || feature.color !== playerColor) continue;
    const pieceType = pieceTypeFromSan(moves[ply]);
    const bucket = profile.byPieceType[pieceType][feature.gamePhase];
    bucket.moveCount++;
    if (feature.isCapture) bucket.tradeInitiatedCount++;
    const bestMove = points.get(ply)?.bestMoveUci;
    if (bestMove) {
      const enginePiece = new Chess(fenBefore).get(bestMove.slice(0, 2) as Parameters<Chess["get"]>[0]);
      if (enginePiece?.type === pieceType) bucket.engineTopMatchCount++;
    }
  }
  profile.evaluatedGameIds.push(gameId);
  profile.gamesEvaluated++;
  profile.confidence = profile.gamesEvaluated >= 15 ? "high" : profile.gamesEvaluated >= 5 ? "medium" : "low";
  profile.builtAt = Date.now();
  return profile;
}
