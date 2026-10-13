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


// --- Evaluation -------------------------------------------------------------

export interface EvalPoint {
  ply: number;
  cpBefore: number | null;   // centipawns, from the mover's POV, before the move. null = mate/unresolved
  cpAfter: number | null;    // centipawns, from the mover's POV, after the move
  mateBefore: number | null; // moves to mate if forced, else null
  mateAfter: number | null;
  depth: number;             // search depth used
}

export interface GameEval {
  gameId: string;
  points: EvalPoint[];       // one per ply, same indexing as MoveFeature
  evaluatedAt: number;       // timestamp, for cache invalidation
  engineVersion: string;     // bump this to invalidate old cached evals on engine upgrade
}

// --- Causality (did the deficit from a candidate move actually hold) -------

export interface CausalityVerdict {
  heldToEnd: boolean;        // deficit never recovered to parity before game end
  worstFollowingCpLoss: number; // the deepest point the position reached after this move
  recoveredAtPly: number | null; // if it DID recover, where
  plyChecked: number;        // how far forward the check walked (may be < game end if game ended early)
}

// --- Flag taxonomy ----------------------------------------------------------

export type FlagType = "collapse" | "pattern_repeat" | "tilt_cascade" | "time_paradox";

export interface FlaggedMove {
  gameId: string;
  ply: number;
  moveNumber: number;
  san: string;
  color: "white" | "black";
  flagType: FlagType;
  timeSpentSec: number;
  phaseAvgSec: number;
  timeRatio: number;
  cpLoss: number;                 // objective eval swing caused by this move
  causality: CausalityVerdict;
  matchedWeaknessId: string | null; // set only for pattern_repeat
  styleDeviationScore: number;     // 0-1, how far this move sits from the player's OWN baseline
  absoluteAnomalyScore: number;    // 0-1, how unusual regardless of baseline
  severity: "low" | "medium" | "high";
  explanation: string;            // human-readable, built from the above (feeds VerdictCard)
}

// --- Weakness profile (Pattern Repeat) --------------------------------------

export interface WeaknessPattern {
  id: string;
  description: string;         // e.g. "collapses under time pressure in opposite-color bishop endgames"
  occurrences: { gameId: string; ply: number }[];
  tags: string[];              // coarse categorical buckets: phase, material pattern, tactical motif
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface WeaknessProfile {
  username: string;
  patterns: WeaknessPattern[];
  evaluatedGameIds: string[];
  gamesEvaluated: number;      // how many games have actually been through Stockfish
  gamesFetched: number;        // how many games we have metadata for (always >= gamesEvaluated)
  confidence: "low" | "medium" | "high"; // derived from gamesEvaluated, surfaced in UI
  builtAt: number;
}