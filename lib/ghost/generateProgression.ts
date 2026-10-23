import { Chess } from "chess.js";
import type { MaiaInferenceResult } from "@/lib/maia/useMaiaWorker";
import { evalFen, type EvalResult } from "@/lib/eval/stockfishEngine";
import { rerankMoves } from "@/lib/maia/rerank";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import type { ProgressionLine, ProgressionMove } from "./progressionCache";

const NEUTRAL_FEATURES: OpponentFeatures = {
  username: "", gamesAnalyzed: 0, mostCommonOpenings: [], queenTradeRate: 0.5,
  aggressionIndex: 0.5, avgRating: null, fetchedAt: 0,
};
// Three full moves by both sides: six half-moves (plies).
const MAX_PLIES = 6;
const DECISIVE_CP = 300;

type Infer = (fen: string, selfRating: number | null, oppRating: number | null) => Promise<MaiaInferenceResult>;

function scoreFromPlayerView(result: EvalResult, fen: string, playerColor: "white" | "black") {
  const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";
  const sign = sideToMove === playerColor ? 1 : -1;
  return {
    cp: result.cp === null ? null : result.cp * sign,
    mate: result.mate === null ? null : result.mate * sign,
  };
}

function decisiveReason(result: EvalResult, fen: string, playerColor: "white" | "black") {
  if (result.mate !== null) return "Forced mate found.";
  const score = scoreFromPlayerView(result, fen, playerColor);
  if (score.cp !== null && score.cp < -DECISIVE_CP) return "Position is decided: Stockfish evaluates it below −3.0 for you.";
  if (score.cp !== null && score.cp > DECISIVE_CP) return "Position is decided: Stockfish evaluates it above +3.0 for you.";
  return null;
}

function applyUci(chess: Chess, uci: string): { san: string; fen: string } | null {
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return move ? { san: move.san, fen: chess.fen() } : null;
  } catch {
    return null;
  }
}

function appendMove(line: ProgressionMove[], chess: Chess, uci: string) {
  const applied = applyUci(chess, uci);
  if (!applied) return null;
  line.push({ uci, san: applied.san, fen: applied.fen, cp: null, mate: null });
  return applied.fen;
}

function continuationPgn(startingFen: string, moves: ProgressionMove[]) {
  const fenFields = startingFen.split(" ");
  let fullmove = Number.parseInt(fenFields[5] ?? "1", 10) || 1;
  let sideToMove = fenFields[1] === "b" ? "b" : "w";
  const sanTokens: string[] = [];
  for (const [index, move] of moves.entries()) {
    if (sideToMove === "w") {
      sanTokens.push(`${fullmove}.`, move.san);
      sideToMove = "b";
    } else {
      if (index === 0) sanTokens.push(`${fullmove}...`);
      sanTokens.push(move.san);
      sideToMove = "w";
      fullmove++;
    }
  }
  return [
    '[Event "Ghost Progression"]',
    '[SetUp "1"]',
    `[FEN "${startingFen}"]`,
    '[Result "*"]',
    "",
    `${sanTokens.join(" ")} *`.trim(),
  ].join("\n");
}

export async function generateEngineBaseline(
  startingFen: string,
  playerColor: "white" | "black",
): Promise<ProgressionLine> {
  const chess = new Chess(startingFen);
  const moves: ProgressionMove[] = [];
  let evaluation = await evalFen(chess.fen());
  let decisive = evaluation.mate !== null || (evaluation.cp !== null && Math.abs(evaluation.cp) > DECISIVE_CP);
  let decisiveAtPly: number | null = decisive ? 0 : null;
  let decisiveNote = decisive ? decisiveReason(evaluation, chess.fen(), playerColor) : null;
  let stopReason: string | null = null;

  while (moves.length < MAX_PLIES && !chess.isGameOver()) {
    const uci = evaluation.bestMoveUci;
    if (!uci) {
      stopReason = "Stockfish returned no legal continuation.";
      break;
    }
    const nextFen = appendMove(moves, chess, uci);
    if (!nextFen) {
      stopReason = "Stockfish returned an invalid move.";
      break;
    }
    evaluation = await evalFen(nextFen);
    moves[moves.length - 1] = { ...moves[moves.length - 1], cp: evaluation.cp, mate: evaluation.mate };
    const reason = decisiveReason(evaluation, nextFen, playerColor);
    if (reason) {
      decisive = true;
      if (decisiveAtPly === null) {
        decisiveAtPly = moves.length;
        decisiveNote = reason;
      }
    }
  }
  if (!stopReason && chess.isGameOver() && moves.length < MAX_PLIES) stopReason = "The game ended before the full line was complete.";

  return {
    id: "engine",
    label: "Engine Baseline (Perfect Play)",
    description: "Stockfish chooses moves for both sides for up to three full moves. This is the analysis reference line.",
    pgn: continuationPgn(startingFen, moves),
    moves,
    decisive,
    decisiveAtPly,
    decisiveNote,
    stopReason,
  };
}

export async function generateMaiaVsEngine(
  startingFen: string,
  maiaColor: "white" | "black",
  userRating: number | null,
  opponentRating: number | null,
  infer: Infer,
  evaluationPerspective: "white" | "black" = maiaColor,
): Promise<ProgressionLine> {
  const chess = new Chess(startingFen);
  if (chess.turn() !== (maiaColor === "white" ? "w" : "b")) {
    throw new Error("The selected position is not Maia's turn, so the Maia continuation cannot start.");
  }

  const moves: ProgressionMove[] = [];
  let nextEngineEvaluation: EvalResult | null = null;
  let decisive = false;
  let decisiveAtPly: number | null = null;
  let decisiveNote: string | null = null;
  let stopReason: string | null = null;

  while (moves.length < MAX_PLIES && !chess.isGameOver()) {
    const userToMove = chess.turn() === (maiaColor === "white" ? "w" : "b");
    let uci: string | null = null;
    if (userToMove) {
      const inference = await infer(chess.fen(), userRating, opponentRating);
      const result = await rerankMoves({ fen: chess.fen(), logitsMaia: inference.logitsMaia, opponentFeatures: NEUTRAL_FEATURES });
      uci = result.baseTopMove?.uci ?? null;
    } else {
      if (!nextEngineEvaluation) nextEngineEvaluation = await evalFen(chess.fen());
      uci = nextEngineEvaluation.bestMoveUci;
    }

    if (!uci) {
      stopReason = userToMove ? "Maia returned no legal continuation." : "Stockfish returned no legal continuation.";
      break;
    }
    const nextFen = appendMove(moves, chess, uci);
    if (!nextFen) {
      stopReason = "The predicted continuation contained an invalid move.";
      break;
    }

    nextEngineEvaluation = await evalFen(nextFen);
    moves[moves.length - 1] = { ...moves[moves.length - 1], cp: nextEngineEvaluation.cp, mate: nextEngineEvaluation.mate };
    const reason = decisiveReason(nextEngineEvaluation, nextFen, evaluationPerspective);
    if (reason) {
      decisive = true;
      if (decisiveAtPly === null) {
        decisiveAtPly = moves.length;
        decisiveNote = reason;
      }
    }
  }
  if (!stopReason && chess.isGameOver() && moves.length < MAX_PLIES) stopReason = "The game ended before the full line was complete.";

  return {
    id: "maia",
    label: "Maia Prediction vs. Engine",
    description: userRating === null
      ? "Maia predicts moves for the side to move using its default rating bucket; Stockfish chooses the replies for up to three full moves."
      : `Maia predicts moves for the side to move at rating ${userRating}; Stockfish chooses the replies for up to three full moves.`,
    pgn: continuationPgn(startingFen, moves),
    moves,
    decisive,
    decisiveAtPly,
    decisiveNote,
    stopReason,
  };
}
