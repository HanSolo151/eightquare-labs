import type {
  GameEval,
  MoveFeature,
  PlayerProfile,
  WeaknessProfile,
} from "../types";
import { flagMoves } from "../lib/flags/flagEngine";

const profile: PlayerProfile = {
  username: "test-player",
  gamesAnalyzed: 1,
  avgMoveTimeSecByPhase: { opening: 10, middlegame: 10, endgame: 10 },
  premoveRate: 0,
  mostCommonOpenings: [],
  avgOpponentRating: 1500,
};

const weaknessProfile: WeaknessProfile = {
  username: "test-player",
  patterns: [],
  evaluatedGameIds: [],
  gamesEvaluated: 1,
  gamesFetched: 1,
  confidence: "low",
  builtAt: Date.now(),
};

function feature(ply: number, color: "white" | "black"): MoveFeature {
  return {
    gameId: "test-game",
    ply,
    moveNumber: 1,
    color,
    san: color === "white" ? "e4" : "e5",
    timeSpentSec: 1,
    clockRemainingSec: 60,
    likelyPremove: false,
    isCapture: false,
    isCheck: false,
    isForcing: false,
    gamePhase: "middlegame",
  };
}

function evalForBlunder(ply: number, playerColor: "white" | "black"): GameEval {
  const points = Array.from({ length: 4 }, (_, index) => {
    const moverColor = index % 2 === 0 ? "white" : "black";
    const playerJustBlundered = index === ply;
    const cpAfter = playerJustBlundered
      ? -150
      : moverColor === playerColor
        ? -200
        : 200;

    return {
      ply: index,
      cpBefore: playerJustBlundered ? 50 : cpAfter,
      cpAfter,
      mateBefore: null,
      mateAfter: null,
      depth: 14,
    };
  });

  return {
    gameId: "test-game",
    points,
    evaluatedAt: Date.now(),
    engineVersion: "test",
  };
}

for (const [ply, color] of [[0, "white"], [1, "black"]] as const) {
  const result = flagMoves(
    [feature(ply, color)],
    profile,
    weaknessProfile,
    evalForBlunder(ply, color),
    color
  );

  if (result.length !== 1 || result[0].flagType !== "collapse" || result[0].cpLoss !== 200) {
    throw new Error(`Expected a 200cp collapse flag for ${color}; got ${JSON.stringify(result)}`);
  }

  console.log(`PASS: ${color} blunder produces a collapse flag with 200cp loss`);
}