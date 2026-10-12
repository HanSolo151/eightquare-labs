import { Chess } from "chess.js";
import type { ParsedGame, MoveFeature, PlayerProfile } from "../../types";

// --- Tunables -------------------------------------------------------------

// Clock-diff below this is treated as a premove: the real thinking happened
// on the opponent's clock, so the timing data for THIS move is unreliable
// and should not feed the "too fast" flag in Step 4.
// Chosen option 1 (threshold cutoff) from the Step 2 design note — simplest,
// ships now. If this proves too blunt once Step 4's real data comes in,
// swap to a per-player rate (option 2) or forcing-move cross-check (option 3)
// without changing the MoveFeature shape.
const PREMOVE_THRESHOLD_SEC = 3;

// A position counts as "forcing" if the mover's move is a capture or check,
// OR the opponent is left with very few legal replies. This second case
// catches forced recaptures / only-moves that aren't captures or checks
// themselves (e.g. a king forced to a single square).
const FORCING_REPLY_LIMIT = 2;

// Rough phase boundaries by full move number. Endgame detection here is
// move-number-based, not material-based — good enough for Step 3; can be
// upgraded to a material-count heuristic later if the move-number cutoff
// proves too crude in practice.
const OPENING_END_MOVE = 12;
const ENDGAME_START_MOVE = 40;

// --- Per-move extraction ----------------------------------------------------

/**
 * Converts a flat ply index (0-indexed, both colors interleaved) into the
 * full move number a human would use to refer to it. Ply 0,1 -> move 1,
 * ply 2,3 -> move 2, etc.
 */
function plyToMoveNumber(ply: number): number {
  return Math.floor(ply / 2) + 1;
}

function gamePhaseForMove(moveNumber: number): MoveFeature["gamePhase"] {
  if (moveNumber <= OPENING_END_MOVE) return "opening";
  if (moveNumber >= ENDGAME_START_MOVE) return "endgame";
  return "middlegame";
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

    const likelyPremove =
      timeSpentSec !== null && timeSpentSec < PREMOVE_THRESHOLD_SEC;

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
      isCapture,
      isCheck,
      isForcing,
      gamePhase: gamePhaseForMove(moveNumber),
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