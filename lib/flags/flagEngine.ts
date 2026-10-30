import type { MoveFeature, PlayerProfile, WeaknessProfile, GameEval, EvalPoint, FlaggedMove } from "@/types";
import { checkCausality } from "./causality";
import { MATE_EQUIVALENT_CP } from "@/lib/eval/toPlayerPerspective";

// Used by opponent timing analytics; it is deliberately not a gate for
// flagging this account's own objective evaluation losses.
export const TIME_RATIO_COLLAPSE_THRESHOLD = 0.35;
export const MIN_CP_LOSS = 100;

// Phase 2: same synthetic "getting mated" cp value used in causality.ts's
// own mate handling (see that file's comment — magnitude needs to match,
// not the exact number). Large enough to always read as catastrophic
// relative to any real cp score.
// Phase 2b: tilt cascade — a run of 2 to 4 consecutive own moves, each
// losing at least CASCADE_PER_MOVE_MIN_CP_LOSS, that together add up to a
// real decline (CASCADE_TOTAL_MIN_CP_LOSS). The per-move bar is
// deliberately lower than MIN_CP_LOSS above — an individual move in the
// run doesn't need to be an outright blunder on its own for the run as a
// whole to represent a tilt.
const CASCADE_MIN_LENGTH = 2;
const CASCADE_MAX_LENGTH = 4;
const CASCADE_PER_MOVE_MIN_CP_LOSS = 50;
const CASCADE_TOTAL_MIN_CP_LOSS = 250;

export function flagMoves(
  moveFeatures: MoveFeature[],
  profile: PlayerProfile,
  weaknessProfile: WeaknessProfile,
  gameEval: GameEval,
  playerColor: "white" | "black"
): FlaggedMove[] {
  // Phase-only buckets are not specific enough to justify recurring-pattern labels.
  void weaknessProfile;
  void profile;
  const individualFlags: FlaggedMove[] = [];
  const evalByPly = new Map(gameEval.points.map((p) => [p.ply, p]));

  // Do not report "by the end of the game" conclusions from partial evals.
  const expectedPlyCount = moveFeatures.reduce((max, move) => Math.max(max, move.ply + 1), 0);
  if (gameEval.points.length !== expectedPlyCount || evalByPly.size !== expectedPlyCount ||
      Array.from({ length: expectedPlyCount }, (_, ply) => evalByPly.has(ply)).some((present) => !present)) {
    return [];
  }

  for (const move of [...moveFeatures].sort((a, b) => a.ply - b.ply)) {
    if (move.color !== playerColor) continue;
    const evalPoint = evalByPly.get(move.ply);
    if (!evalPoint) continue;
    const resolved = resolveCpLoss(evalPoint);
    if (!resolved) continue;
    const { cpLoss, evalConfidence } = resolved;
    if (cpLoss < MIN_CP_LOSS) continue;

    const causality = checkCausality(gameEval, move.ply, playerColor);
    if (!causality.heldToEnd) continue;

    // Timing is descriptive context, never an eligibility gate or a claim
    // about the player's mental state. A flagged move stays flaggable when
    // clocks are absent, the profile is sparse, or the move was very fast.
    individualFlags.push(buildFlag(
      move, 1, 0, cpLoss, causality, "decision_error", null, evalConfidence,
    ));
  }

  const cascades = detectTiltCascades(moveFeatures, evalByPly, playerColor, gameEval);
  // A cascade is a summary of the included individual losses, not an extra
  // duplicate event at its final ply.
  const cascadeRanges = cascades.map((flag) => flag.cascadeMeta!).filter(Boolean);
  const standalone = individualFlags.filter((flag) => !cascadeRanges.some((range) =>
    flag.ply >= range.startPly && flag.ply <= range.startPly + range.sequenceLength * 2 - 2
  ));
  return [...standalone, ...cascades].sort((a, b) => b.cpLoss - a.cpLoss);
}

/**
 * Phase 0/2 gap: resolves a move's cpLoss, now including the mate-only case
 * that used to be invisible to the flagger entirely (continue'd past
 * silently in flagMoves before this change). Returns null when there's no
 * usable comparison — same exclusion as before for that case.
 */
export function resolveCpLoss(evalPoint: EvalPoint): { cpLoss: number; evalConfidence: FlaggedMove["evalConfidence"] } | null {
  if (!Number.isFinite(evalPoint.depth) || evalPoint.depth < 8) return null;
  if ((evalPoint.cpBefore !== null && evalPoint.mateBefore !== null) ||
      (evalPoint.cpAfter !== null && evalPoint.mateAfter !== null)) return null;
  const before = scoreFromEval(evalPoint.cpBefore, evalPoint.mateBefore);
  const after = scoreFromEval(evalPoint.cpAfter, evalPoint.mateAfter);
  if (before === null || after === null) return null;
  return {
    cpLoss: before - after,
    evalConfidence: evalPoint.depth < 10
      ? "degraded"
      : evalPoint.mateBefore !== null || evalPoint.mateAfter !== null ? "mate_only" : "full",
  };
}

function scoreFromEval(cp: number | null, mate: number | null): number | null {
  if (cp !== null && Number.isFinite(cp)) return cp;
  if (mate === null || !Number.isFinite(mate)) return null;
  const distance = Math.min(Math.abs(mate), 999);
  return mate > 0 ? MATE_EQUIVALENT_CP - distance : -MATE_EQUIVALENT_CP + distance;
}

/**
 * Phase 2b: scans the player's own moves in ply order for a run of 2–4
 * consecutive moves that each lose at least CASCADE_PER_MOVE_MIN_CP_LOSS,
 * where the run's total loss clears CASCADE_TOTAL_MIN_CP_LOSS. Greedy,
 * non-overlapping: once a run is found (or a potential run is rejected),
 * scanning continues from the next unconsumed move. A move can still also
 * be flagged individually as collapse/time_paradox/pattern_repeat by the
 * main loop above — tilt_cascade flags are additive, not exclusive of those
 * (a cascade and a single-move collapse flag describe different things and
 * deliberately aren't deduplicated against each other here).
 */
function detectTiltCascades(
  moveFeatures: MoveFeature[],
  evalByPly: Map<number, EvalPoint>,
  playerColor: "white" | "black",
  gameEval: GameEval
): FlaggedMove[] {
  const ownMoves = moveFeatures
    .filter((m) => m.color === playerColor)
    .sort((a, b) => a.ply - b.ply);

  const flagged: FlaggedMove[] = [];
  let i = 0;

  while (i < ownMoves.length) {
    let runEnd = i;
    let totalLoss = 0;

    while (runEnd < ownMoves.length && runEnd - i < CASCADE_MAX_LENGTH) {
      const evalPoint = evalByPly.get(ownMoves[runEnd].ply);
      if (!evalPoint) break;
      const resolved = resolveCpLoss(evalPoint);
      if (!resolved || resolved.evalConfidence !== "full") break;
      const cpLoss = resolved.cpLoss;
      if (cpLoss < CASCADE_PER_MOVE_MIN_CP_LOSS) break;
      totalLoss += cpLoss;
      runEnd++;
    }

    const runLength = runEnd - i;
    if (runLength >= CASCADE_MIN_LENGTH && totalLoss >= CASCADE_TOTAL_MIN_CP_LOSS) {
      const firstMove = ownMoves[i];
      const lastMove = ownMoves[runEnd - 1];
      const causality = checkCausality(gameEval, firstMove.ply, playerColor);
      if (causality.heldToEnd) {
        flagged.push(
          buildCascadeFlag(lastMove, ownMoves[i].ply, runLength, Math.round(totalLoss), causality)
        );
      }
      i = runEnd; // don't let the next run overlap this one
    } else {
      i++;
    }
  }

  return flagged;
}

function buildCascadeFlag(
  lastMove: MoveFeature,
  startPly: number,
  sequenceLength: number,
  totalLossCp: number,
  causality: ReturnType<typeof checkCausality>
): FlaggedMove {
  const timeSpentSec = lastMove.timeSpentSec ?? 0;
  const timeRatio = 1;

  const severityBreakdown = computeSeverityBreakdown({
    cpLoss: totalLossCp,
    flagType: "evaluation_cascade",
  });

  return {
    gameId: lastMove.gameId, ply: lastMove.ply, moveNumber: lastMove.moveNumber, san: lastMove.san, color: lastMove.color,
    ratio: Number(timeRatio.toFixed(2)), clockRemainingSec: lastMove.clockRemainingSec ?? 0, gamePhase: lastMove.gamePhase,
    flagType: "evaluation_cascade", timeSpentSec, phaseAvgSec: 0, timeRatio: Number(timeRatio.toFixed(2)),
    cpLoss: totalLossCp, causality, matchedWeaknessId: null,
    styleDeviationScore: 0,
    absoluteAnomalyScore: Math.min(1, totalLossCp / 500),
    severity: severityFromBreakdown(severityBreakdown),
    severityBreakdown,
    pivotMove: null,
    cascadeMeta: { sequenceLength, depthCp: totalLossCp, startPly },
    evalConfidence: "full", // cascade detection only walks moves with real cp-before/after pairs
    explanation: `The position evaluation fell by ${(totalLossCp / 100).toFixed(1)} pawns across ${sequenceLength} consecutive moves and did not recover.`,
  };
}

function buildFlag(
  move: MoveFeature, timeRatio: number, phaseAvg: number, cpLoss: number,
  causality: ReturnType<typeof checkCausality>, flagType: FlaggedMove["flagType"], weaknessId: string | null,
  evalConfidence: FlaggedMove["evalConfidence"]
): FlaggedMove {
  const roundedCpLoss = Math.round(cpLoss);
  const severityBreakdown = computeSeverityBreakdown({ cpLoss: roundedCpLoss, flagType, timeRatio });
  return {
    gameId: move.gameId, ply: move.ply, moveNumber: move.moveNumber, san: move.san, color: move.color,
    ratio: Number(timeRatio.toFixed(2)), clockRemainingSec: move.clockRemainingSec ?? 0, gamePhase: move.gamePhase,
    flagType, timeSpentSec: move.timeSpentSec ?? 0, phaseAvgSec: phaseAvg, timeRatio: Number(timeRatio.toFixed(2)),
    cpLoss: roundedCpLoss, causality, matchedWeaknessId: weaknessId,
    styleDeviationScore: Math.min(1, Math.abs(1 - timeRatio)),
    absoluteAnomalyScore: Math.min(1, cpLoss / 500),
    severity: severityFromBreakdown(severityBreakdown),
    severityBreakdown,
    pivotMove: null, // Phase 3
    cascadeMeta: null, // only tilt_cascade flags (built via buildCascadeFlag) carry this
    evalConfidence,
    explanation: explain(flagType, cpLoss, evalConfidence),
  };
}

/**
 * Phase 2c: multi-factor severity, replacing the old pure-cpLoss formula.
 * evalLoss carries the same weight cpLoss always did; the three bonuses are
 * additive on top, so pure cpLoss cases without any bonus behave exactly
 * as before — a plain collapse/time_paradox flag with no pattern match and
 * mild rush only shifts if the bonuses push it over a bucket boundary.
 */
function computeSeverityBreakdown(opts: {
  cpLoss: number;
  flagType: FlaggedMove["flagType"];
  timeRatio?: number;
}): FlaggedMove["severityBreakdown"] {
  const evalLoss = Math.round(opts.cpLoss);
  return { evalLoss, patternMatchBonus: 0, rushBonus: 0, tiltBonus: 0 };
}

function severityFromBreakdown(b: FlaggedMove["severityBreakdown"]): "low" | "medium" | "high" {
  const score = b.evalLoss + b.patternMatchBonus + b.rushBonus + b.tiltBonus;
  if (score > 200) return "high";
  if (score >= 100) return "medium";
  return "low";
}

function explain(flagType: FlaggedMove["flagType"], cpLoss: number, evalConfidence: FlaggedMove["evalConfidence"]): string {
  if (evalConfidence === "mate_only") {
    return "The engine's evaluation crossed or changed a forced-mate line. The stored loss uses a synthetic mate scale, not centipawns.";
  }
  const loss = `${(cpLoss / 100).toFixed(1)} pawns`;
  if (flagType === "tilt_cascade" || flagType === "evaluation_cascade") return `The position evaluation fell by ${loss} across a run of consecutive moves and did not recover.`;
  return `This move lost about ${loss} of engine evaluation, and the position did not recover to within half a pawn of its pre-move evaluation by the end of the game.`;
}
