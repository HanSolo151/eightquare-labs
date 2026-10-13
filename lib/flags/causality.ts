import type { GameEval, CausalityVerdict } from "@/types";

const PARITY_THRESHOLD_CP = 50; // back within half a pawn counts as "recovered" — tunable, not validated

export function checkCausality(
  gameEval: GameEval,
  candidatePly: number,
  playerColor: "white" | "black"
): CausalityVerdict {
  const atCandidate = gameEval.points[candidatePly];
  if (!atCandidate || atCandidate.cpAfter === null) {
    return { heldToEnd: false, worstFollowingCpLoss: 0, recoveredAtPly: null, plyChecked: candidatePly };
  }

  const cpAfterMove = toPlayerPerspective(atCandidate.cpAfter, candidatePly, playerColor);
  let worst = cpAfterMove;
  let recoveredAtPly: number | null = null;

  for (let ply = candidatePly + 1; ply < gameEval.points.length; ply++) {
    const cp = gameEval.points[ply].cpAfter;
    if (cp === null) continue;
    const ownCp = toPlayerPerspective(cp, ply, playerColor);
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

function toPlayerPerspective(cp: number, ply: number, playerColor: "white" | "black"): number {
  const moverColor = ply % 2 === 0 ? "white" : "black";
  return moverColor === playerColor ? cp : -cp;
}