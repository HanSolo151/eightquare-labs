export interface ParsedGame {
  id: string;
  playerColor: "white" | "black";
  opponentUsername: string;
  opponentRating: number | null;
  playerRating: number | null;
  moves: string[]; // SAN moves, index 0 = white's first move
  clocks: number[] | null; // centiseconds remaining, one per ply, null if not requested
  clockInitialSec?: number | null;
  clockIncrementSec?: number | null;
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
  // Phase 2a: premove vs genuine snap decision, split by position complexity
  // (not just elapsed time). likelyPremove === true excludes the move from
  // flagging AND from the player-profile timing baseline, same as before.
  // isSnapDecision === true means it's a FAST but genuine decision in a
  // complex position — NOT excluded, eligible for collapse flagging.
  // A move is never both true at once. See extractFeatures.ts for the
  // classification logic.
  likelyPremove: boolean;
  isSnapDecision: boolean;
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

export type GamePhase = "opening" | "middlegame" | "endgame";

export interface PhaseTimePressure {
  phaseAvgSec: number | null;
  sampleSize: number;
  collapseCount: number;
  collapseRate: number;
  confidence: "low" | "medium" | "high";
}

export interface OpponentTimePressureProfile {
  username: string;
  timingVersion?: number;
  gamesAnalyzed: number;
  evaluatedGameIds: string[];
  byPhase: Record<GamePhase, PhaseTimePressure>;
}


// --- Evaluation -------------------------------------------------------------

export interface EvalPoint {
  ply: number;
  cpBefore: number | null;   // centipawns, from the mover's POV, before the move. null = mate/unresolved
  cpAfter: number | null;    // centipawns, from the mover's POV, after the move
  mateBefore: number | null; // moves to mate if forced, else null
  mateAfter: number | null;
  depth: number;             // search depth used
  bestMoveUci: string | null; // engine's top move from the position before this ply
}

// --- Piece-activity profiling -----------------------------------------------
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface PieceActivityPhaseBucket {
  moveCount: number;
  tradeInitiatedCount: number;
  engineTopMatchCount: number;
}

export interface PieceActivityProfile {
  username: string;
  byPieceType: Record<PieceType, Record<MoveFeature["gamePhase"], PieceActivityPhaseBucket>>;
  evaluatedGameIds: string[];
  gamesEvaluated: number;
  confidence: "low" | "medium" | "high";
  builtAt: number;
}

export interface GameEval {
  gameId: string;
  points: EvalPoint[];       // one per ply, same indexing as MoveFeature
  evaluatedAt: number;       // timestamp, for cache invalidation
  engineVersion: string;     // bump this to invalidate old cached evals on engine upgrade
}

// --- Opening tree (opponent's observed opening choices) --------------------
export interface OpeningTree {
  username: string;
  positions: Record<string, Record<string, number>>;
  evaluatedGameIds: string[];
  gamesEvaluated: number;
  builtAt: number;
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

// --- Pivot-move attribution (Phase 3) ---------------------------------------
// Populated starting in Phase 3. Until then every FlaggedMove.pivotMove is null.

export interface PivotMoveAttribution {
  ply: number;                    // the opponent move being attributed as the pivot
  san: string;
  // Best-line versus played-line gap. Meaningful only when wasInTopN is true;
  // otherwise 0 is a cost-saving fallback, not a zero-shift claim.
  evalShiftCp: number;
  wasTopEngineChoice: boolean;    // true if this was Stockfish's top line
  wasInTopN: boolean;             // true if within Stockfish's top-3 lines (requires multiPV)
  complexityDelta: number;        // change in position complexity (forcing-reply-count based) across this move
}

export interface FlaggedMove {
  gameId: string;
  ply: number;
  moveNumber: number;
  san: string;
  color: "white" | "black";
  flagType: FlagType;

  // Time-pressure fields (ratio/timeRatio and phaseAvgSec/timeSpentSec are
  // duplicates kept from two historical shapes of this type that TS was
  // silently merging — both are populated by flagEngine.buildFlag, collapsing
  // them is a later cleanup, not a Phase 1 concern).
  timeSpentSec: number;
  phaseAvgSec: number;
  timeRatio: number;
  ratio: number;
  clockRemainingSec: number;
  gamePhase: MoveFeature["gamePhase"];

  cpLoss: number;                 // objective eval swing caused by this move
  causality: CausalityVerdict;
  matchedWeaknessId: string | null; // set only for pattern_repeat
  styleDeviationScore: number;     // 0-1, how far this move sits from the player's OWN baseline
  absoluteAnomalyScore: number;    // 0-1, how unusual regardless of baseline

  // Stored severity bucket. UI components (VerdictCard etc.) branch on this
  // string today — keep it a plain "low"|"medium"|"high", don't restructure.
  severity: "low" | "medium" | "high";
  // Inspectable inputs behind `severity`. Phase 1 adds the field; Phase 2's
  // multi-factor formula is what actually populates patternMatchBonus/rushBonus/
  // tiltBonus with non-zero values. Until then this just mirrors cpLoss so the
  // shape is already in place for Phase 2 to write into.
  severityBreakdown: {
    evalLoss: number;
    patternMatchBonus: number;
    rushBonus: number;
    tiltBonus: number;
  };

  // Set once Phase 3's pivot-move attribution exists. Null until then.
  pivotMove: PivotMoveAttribution | null;

  // Set once Phase 2's tilt-cascade detector exists. Null until then (and
  // null for every flag that isn't flagType "tilt_cascade").
  cascadeMeta: { sequenceLength: number; depthCp: number; startPly: number } | null;

  // How much to trust the eval backing this flag. Every flag built today
  // passed flagEngine's `cpAfter !== null` filter, so this is always "full"
  // right now. "mate_only" is the Phase 0 gap (mate-after plies currently
  // never reach buildFlag at all — see flagEngine.ts line 23); "degraded" is
  // reserved for a future lower-depth or structurally-incomplete eval read.
  evalConfidence: "full" | "mate_only" | "degraded";

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
