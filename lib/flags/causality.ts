import type { GameEval, CausalityVerdict } from "@/types";
import { MATE_EQUIVALENT_CP, toPlayerPerspective } from "@/lib/eval/toPlayerPerspective";

const PARITY_THRESHOLD_CP = 50; // back within half a pawn counts as "recovered" — tunable, not validated

// Phase 2 edge case (flagged in the Phase 0/2 audit): flagEngine's mate-only
// handling can now reach this function with a candidate whose cpAfter is
// null but mateAfter isn't (see flagEngine.ts's resolvedCpLoss). This used
// to be moot because flagEngine filtered those out before ever calling
// checkCausality — now that it doesn't, a plain `cpAfter === null` guard
// here would auto-fail causality for every mate-only flag and silently
// defeat the point of surfacing them. Must stay large enough to always read
// as "worse than any real cp score" — doesn't need to match flagEngine's
// mate-equivalent constant exactly, just the same order of magnitude.
export function checkCausality(
  gameEval: GameEval,
  candidatePly: number,
  playerColor: "white" | "black"
): CausalityVerdict {
  const atCandidate = gameEval.points[candidatePly];
  if (!atCandidate) {
    return { heldToEnd: false, worstFollowingCpLoss: 0, recoveredAtPly: null, plyChecked: candidatePly };
  }

  let cpAfterMove: number;
  if (atCandidate.cpAfter !== null) {
    cpAfterMove = toPlayerPerspective(atCandidate.cpAfter, candidatePly, playerColor);
  } else if (atCandidate.mateAfter !== null && atCandidate.mateAfter < 0) {
    // mateAfter is already in the mover's POV (see evalCache.normalizeEvalPoint);
    // negative means the MOVER is the one facing forced mate — substitute a
    // large synthetic cp value so the walk-forward recovery check below
    // still works the same way it does for a real cp score.
    cpAfterMove = -MATE_EQUIVALENT_CP;
  } else {
    // No usable eval (still-missing cp, or mateAfter positive — mover
    // delivers mate, which flagEngine never treats as a blunder and
    // shouldn't be reaching this function in the first place).
    return { heldToEnd: false, worstFollowingCpLoss: 0, recoveredAtPly: null, plyChecked: candidatePly };
  }

  let worst = cpAfterMove;
  let recoveredAtPly: number | null = null;

  for (let ply = candidatePly + 1; ply < gameEval.points.length; ply++) {
    const point = gameEval.points[ply];
    let ownCp: number;
    if (point.cpAfter !== null) {
      ownCp = toPlayerPerspective(point.cpAfter, ply, playerColor);
    } else if (point.mateAfter !== null) {
      // mateAfter uses the mover's perspective: negative means that mover
      // faces mate, positive means they delivered mate.
      const moverCp = point.mateAfter < 0 ? -MATE_EQUIVALENT_CP : MATE_EQUIVALENT_CP;
      ownCp = toPlayerPerspective(moverCp, ply, playerColor);
    } else {
      continue;
    }
    worst = Math.min(worst, ownCp);
    if (ownCp > -PARITY_THRESHOLD_CP) {
      recoveredAtPly = ply;
      break;
    }
  }

  return {
    heldToEnd: recoveredAtPly === null,
    worstFollowingCpLoss: worst,
    recoveredAtPly,
    plyChecked: gameEval.points.length - 1,
  };
}
