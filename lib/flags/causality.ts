import type { GameEval, CausalityVerdict, EvalPoint } from "@/types";
import { MATE_EQUIVALENT_CP, toPlayerPerspective } from "@/lib/eval/toPlayerPerspective";

/** A recovery within half a pawn of the pre-move evaluation counts as repaired. */
export const RECOVERY_TOLERANCE_CP = 50;

function moverScore(cp: number | null, mate: number | null): number | null {
  if (cp !== null && Number.isFinite(cp)) return cp;
  if (mate === null || !Number.isFinite(mate)) return null;
  // Preserve mate-vs-cp ordering and make shorter forced mates more valuable.
  const distance = Math.min(Math.abs(mate), 999);
  return mate > 0 ? MATE_EQUIVALENT_CP - distance : -MATE_EQUIVALENT_CP + distance;
}

function scoreForPlayer(point: EvalPoint, field: "before" | "after", ply: number, playerColor: "white" | "black"): number | null {
  const score = moverScore(point[`cp${field === "before" ? "Before" : "After"}`], point[`mate${field === "before" ? "Before" : "After"}`]);
  if (score === null) return null;
  return toPlayerPerspective(score, ply, playerColor);
}

/**
 * A candidate's damage is considered repaired only if the player's later
 * position returns close to the score immediately before the candidate move.
 * Missing evaluations never count as evidence of recovery.
 */
export function checkCausality(
  gameEval: GameEval,
  candidatePly: number,
  playerColor: "white" | "black"
): CausalityVerdict {
  const points = [...gameEval.points].sort((a, b) => a.ply - b.ply);
  const atCandidate = points.find((point) => point.ply === candidatePly);
  if (!atCandidate || candidatePly % 2 !== (playerColor === "white" ? 0 : 1)) {
    return { heldToEnd: false, worstFollowingCpLoss: 0, recoveredAtPly: null, plyChecked: candidatePly };
  }

  const baseline = scoreForPlayer(atCandidate, "before", candidatePly, playerColor);
  const afterCandidate = scoreForPlayer(atCandidate, "after", candidatePly, playerColor);
  if (baseline === null || afterCandidate === null) {
    return { heldToEnd: false, worstFollowingCpLoss: 0, recoveredAtPly: null, plyChecked: candidatePly };
  }

  let worst = afterCandidate;
  let plyChecked = candidatePly;
  let expectedPly = candidatePly + 1;
  for (const point of points) {
    if (point.ply <= candidatePly) continue;
    if (point.ply !== expectedPly) {
      return { heldToEnd: false, worstFollowingCpLoss: worst, recoveredAtPly: null, plyChecked };
    }
    expectedPly++;
    const ownScore = scoreForPlayer(point, "after", point.ply, playerColor);
    if (ownScore === null) {
      return { heldToEnd: false, worstFollowingCpLoss: worst, recoveredAtPly: null, plyChecked };
    }
    plyChecked = point.ply;
    worst = Math.min(worst, ownScore);
    if (ownScore >= baseline - RECOVERY_TOLERANCE_CP) {
      return { heldToEnd: false, worstFollowingCpLoss: worst, recoveredAtPly: point.ply, plyChecked };
    }
  }

  return { heldToEnd: true, worstFollowingCpLoss: worst, recoveredAtPly: null, plyChecked };
}
