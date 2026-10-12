export interface ParsedGame {
  id: string;
  playerColor: "white" | "black";
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  moves: string[]; // SAN moves, index 0 = white's first move
  clocks: number[] | null; // centiseconds remaining, one per ply, null if not requested
  openingName: string | null;
  openingEco: string | null;
  result: "win" | "loss" | "draw";
  rated: boolean;
  speed: string | null;
  createdAt: number | null;
}

// Append these to types/index.ts (ParsedGame already exists there from Step 2)

export interface MoveFeature {
  gameId: string;
  ply: number;               // 0-indexed position in the flat moves array
  moveNumber: number;        // full move number, e.g. 14 (NOT ply)
  color: "white" | "black";
  san: string;
  timeSpentSec: number | null;   // null if clocks missing or index out of bounds
  clockRemainingSec: number | null;
  likelyPremove: boolean;        // true if timeSpentSec < PREMOVE_THRESHOLD_SEC
  isCapture: boolean;
  isCheck: boolean;
  isForcing: boolean;            // capture, check, or opponent has <= FORCING_REPLY_LIMIT legal replies
  gamePhase: "opening" | "middlegame" | "endgame";
}

export interface PlayerProfile {
  username: string;
  gamesAnalyzed: number;
  avgMoveTimeSecByPhase: {
    opening: number | null;
    middlegame: number | null;
    endgame: number | null;
  };
  premoveRate: number;            // 0-1, fraction of moves flagged likelyPremove
  mostCommonOpenings: { name: string; eco: string; count: number }[];
  avgOpponentRating: number | null;
  // TODO (Step 4 or later): blunderRateByClockCondition.
  // Needs a position evaluation source (Maia-2 inference from Step 7, or a
  // separate eval engine). Not computable from parsed game data alone, so
  // deliberately omitted here rather than faked.
}


export interface FlaggedMove {
  gameId: string;
  ply: number;
  moveNumber: number;
  san: string;
  timeSpentSec: number;
  phaseAvgSec: number;
  ratio: number;
  clockRemainingSec: number;
  gamePhase: MoveFeature["gamePhase"];
  severity: "low" | "medium" | "high";
}