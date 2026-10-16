import { Chess } from "chess.js";
import type { ParsedGame, MoveFeature, PlayerProfile } from "../../types";

// --- Tunables -------------------------------------------------------------

// Phase 2a: split "fast move" into two buckets by position complexity,
// instead of one flat cutoff. Below PREMOVE_THRESHOLD_SEC in a tactically
// simple position, it's a true premove — unreliable timing data, still
// excluded entirely (from flagging AND from the profile timing baseline).
// Between PREMOVE_THRESHOLD_SEC and SNAP_DECISION_MAX_SEC in a COMPLEX
// position, it's a genuine fast decision — no longer excluded, now eligible
// for collapse flagging. The same window in a SIMPLE position (a fast,
// obviously-forced reply) still gets excluded, same as the old flat cutoff —
// there's no real decision happening there either way.
const PREMOVE_THRESHOLD_SEC = 1;
const SNAP_DECISION_MAX_SEC = 4;

// A position counts as "forcing" if the mover's move is a capture or check,
// OR the opponent is left with very few legal replies. This second case
// catches forced recaptures / only-moves that aren't captures or checks
// themselves (e.g. a king forced to a single square).
const FORCING_REPLY_LIMIT = 2;

// Rough phase boundaries by full move number. OPENING_END_MOVE still gates
// the "opening" phase (see gamePhaseForPosition below) — material alone
// can't tell "still in known theory" apart from "early middlegame with no
// trades yet", both look like full material on the board. Endgame detection
// (Phase 2d) no longer uses move number at all; it's material-based.
const OPENING_END_MOVE = 12;

// Phase 2d: fraction of total non-king material (both sides combined)
// remaining on the board, below which the position counts as an endgame.
// FULL_MATERIAL = 2 * (8 pawns + 2 knights + 2 bishops + 2 rooks + 1 queen)
// = 2 * (8*1 + 2*3 + 2*3 + 2*5 + 1*9) = 78, kings excluded (always present,
// carry no material-count signal).
const ENDGAME_MATERIAL_FRACTION = 0.5;
const FULL_MATERIAL = 78;
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

// --- Per-move extraction ----------------------------------------------------

/**
 * Converts a flat ply index (0-indexed, both colors interleaved) into the
 * full move number a human would use to refer to it. Ply 0,1 -> move 1,
 * ply 2,3 -> move 2, etc.
 */
function plyToMoveNumber(ply: number): number {
  return Math.floor(ply / 2) + 1;
}

/** Sum of standard piece values on the board, both colors, kings excluded. */
function materialCount(chess: Chess): number {
  let total = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      total += PIECE_VALUES[square.type] ?? 0;
    }
  }
  return total;
}

/**
 * Phase 2d: material-based phase detection, replacing the old pure
 * move-number cutoffs. Endgame is now driven by how much material has
 * actually left the board — a game that trades down fast (e.g. an early
 * queen trade) counts as endgame well before move 40, and a long
 * maneuvering middlegame that stays material-heavy past move 40 doesn't
 * flip to "endgame" just because that move number arrived. Opening is still
 * move-number-gated (see OPENING_END_MOVE above) since material alone can't
 * distinguish "still in known theory" from "early middlegame, no trades yet".
 */
function gamePhaseForPosition(moveNumber: number, chess: Chess): MoveFeature["gamePhase"] {
  const materialFraction = materialCount(chess) / FULL_MATERIAL;
  if (materialFraction <= ENDGAME_MATERIAL_FRACTION) return "endgame";
  if (moveNumber <= OPENING_END_MOVE) return "opening";
  return "middlegame";
}

/**
 * Phase 2a: classifies a fast move as a true premove (excluded) or a
 * genuine snap decision (included, flaggable) based on position complexity,
 * using `isForcing` as the complexity signal — a forcing position (our move
 * is a capture/check, or leaves the opponent almost no replies) is treated
 * as tactically SIMPLE, since there's little genuine decision happening.
 */
function classifyMoveSpeed(
  timeSpentSec: number | null,
  isForcing: boolean
): { likelyPremove: boolean; isSnapDecision: boolean } {
  if (timeSpentSec === null) return { likelyPremove: false, isSnapDecision: false };

  const isComplexPosition = !isForcing;

  if (timeSpentSec < PREMOVE_THRESHOLD_SEC) {
    // Under 1s is treated as noise regardless of apparent complexity — a
    // sub-second reaction isn't enough to credit as a real decision even
    // when isForcing didn't flag the position as simple.
    return { likelyPremove: true, isSnapDecision: false };
  }
  if (timeSpentSec < SNAP_DECISION_MAX_SEC) {
    if (isComplexPosition) return { likelyPremove: false, isSnapDecision: true };
    // Fast move in a simple/forced position: not a meaningful signal either
    // way, same exclusion the old flat cutoff gave this whole window.
    return { likelyPremove: true, isSnapDecision: false };
  }
  return { likelyPremove: false, isSnapDecision: false };
}

/**
 * Extracts one MoveFeature per ply in a parsed game. Replays the game
 * through chess.js move by move (rather than trusting SAN blindly) so we
 * get accurate capture/check flags and legal-reply counts for the forcing
 * check.
 *
 * Returns an empty array (rather than throwing) if the game's moves can't
 * be replayed — e.g. a corrupted SAN string — since Step 2 already filters
 * out most malformed games, and a single bad game shouldn't crash a batch.
 */
export function extractMoveFeatures(game: ParsedGame): MoveFeature[] {
  const chess = new Chess();
  const features: MoveFeature[] = [];

  // Defensive: Step 2 noted clocks.length may not equal moves.length for
  // aborted/bye games. Never assume a 1:1 index match.
  const clocks = game.clocks;

  for (let ply = 0; ply < game.moves.length; ply++) {
    const san = game.moves[ply];
    const color: MoveFeature["color"] = ply % 2 === 0 ? "white" : "black";

    let moveResult;
    try {
      moveResult = chess.move(san);
    } catch {
      // Unplayable SAN at this point — stop extracting for this game rather
      // than guessing. Partial results are still returned for the plies
      // already processed.
      break;
    }
    if (!moveResult) break;

    const isCapture = moveResult.flags.includes("c") || moveResult.flags.includes("e"); // capture or en passant
    const isCheck = chess.isCheck();

    // Legal replies available to the opponent in the resulting position.
    const replyCount = chess.moves().length;
    const isForcing = isCapture || isCheck || replyCount <= FORCING_REPLY_LIMIT;

    // Timing: clock[i] is the clock AFTER the move at ply i was made, but
    // the array alternates colors — clock[i] and clock[i-1] belong to
    // DIFFERENT players. To get time spent on THIS move, compare against
    // the same color's own previous reading, which is two plies back:
    // clock[ply - 2], not clock[ply - 1]. (Originally got this wrong —
    // comparing adjacent plies mixes white's and black's clocks and
    // produces nonsense, including impossible negative values even with
    // no increment on the clock, which is what surfaced the bug.)
    let timeSpentSec: number | null = null;
    let clockRemainingSec: number | null = null;
    if (clocks && ply < clocks.length) {
      clockRemainingSec = clocks[ply] / 100;
      // ply 0 and ply 1 have no same-color prior reading in the array
      // (each color's very first move), so time spent is left null rather
      // than guessed.
      if (ply >= 2 && ply - 2 < clocks.length) {
        const prevSameColorClockCs = clocks[ply - 2];
        timeSpentSec = (prevSameColorClockCs - clocks[ply]) / 100;
      }
    }

    const { likelyPremove, isSnapDecision } = classifyMoveSpeed(timeSpentSec, isForcing);

    const moveNumber = plyToMoveNumber(ply);

    features.push({
      gameId: game.id,
      ply,
      moveNumber,
      color,
      san,
      timeSpentSec,
      clockRemainingSec,
      likelyPremove,
      isSnapDecision,
      isCapture,
      isCheck,
      isForcing,
      gamePhase: gamePhaseForPosition(moveNumber, chess),
    });
  }

  return features;
}

/** Batch wrapper — flattens move features across many games. */
export function extractAllMoveFeatures(games: ParsedGame[]): MoveFeature[] {
  return games.flatMap(extractMoveFeatures);
}

// --- Player profile ----------------------------------------------------

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Builds an aggregate profile from parsed games + their extracted move
 * features. Only includes the player's OWN moves (filtered by color match
 * to game.playerColor), not the opponent's.
 *
 * Premoved moves (likelyPremove === true) are excluded from the average
 * move-time calculation — including them would silently drag every
 * phase average toward zero for a heavy premover and defeat the purpose
 * of Step 4's "too fast" comparison baseline.
 */
export function buildPlayerProfile(
  username: string,
  games: ParsedGame[],
  allMoveFeatures: MoveFeature[]
): PlayerProfile {
  const featuresByGame = new Map<string, MoveFeature[]>();
  for (const f of allMoveFeatures) {
    if (!featuresByGame.has(f.gameId)) featuresByGame.set(f.gameId, []);
    featuresByGame.get(f.gameId)!.push(f);
  }

  const ownTimesByPhase: Record<MoveFeature["gamePhase"], number[]> = {
    opening: [],
    middlegame: [],
    endgame: [],
  };

  let premoveCount = 0;
  let ownMoveCount = 0;
  const openingTally = new Map<string, { eco: string; count: number }>();
  const opponentRatings: number[] = [];

  for (const game of games) {
    const feats = featuresByGame.get(game.id) ?? [];
    for (const f of feats) {
      if (f.color !== game.playerColor) continue;
      ownMoveCount++;
      if (f.likelyPremove) {
        premoveCount++;
        continue; // excluded from timing averages, per note above
      }
      if (f.timeSpentSec !== null) {
        ownTimesByPhase[f.gamePhase].push(f.timeSpentSec);
      }
    }

    if (game.openingName) {
      const key = game.openingName;
      const entry = openingTally.get(key) ?? {
        eco: game.openingEco ?? "",
        count: 0,
      };
      entry.count++;
      openingTally.set(key, entry);
    }

    if (typeof game.opponentRating === "number") {
      opponentRatings.push(game.opponentRating);
    }
  }

  const mostCommonOpenings = [...openingTally.entries()]
    .map(([name, v]) => ({ name, eco: v.eco, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    username,
    gamesAnalyzed: games.length,
    avgMoveTimeSecByPhase: {
      opening: average(ownTimesByPhase.opening),
      middlegame: average(ownTimesByPhase.middlegame),
      endgame: average(ownTimesByPhase.endgame),
    },
    premoveRate: ownMoveCount > 0 ? premoveCount / ownMoveCount : 0,
    mostCommonOpenings,
    avgOpponentRating: average(opponentRatings),
  };
}