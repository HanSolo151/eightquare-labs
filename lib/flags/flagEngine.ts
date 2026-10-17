import type { MoveFeature, PlayerProfile, WeaknessProfile, GameEval, EvalPoint, FlaggedMove } from "@/types";
import { checkCausality } from "./causality";

export const TIME_RATIO_COLLAPSE_THRESHOLD = 0.35;
const TIME_RATIO_PARADOX_SLOW_THRESHOLD = 1.8; // "spent way more time than usual and still got it wrong"
export const MIN_CP_LOSS = 100;

// Phase 2: same synthetic "getting mated" cp value used in causality.ts's
// own mate handling (see that file's comment — magnitude needs to match,
// not the exact number). Large enough to always read as catastrophic
// relative to any real cp score.
const MATE_EQUIVALENT_CP = 10000;

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
  const flagged: FlaggedMove[] = [];
  const evalByPly = new Map(gameEval.points.map((p) => [p.ply, p]));

  for (const move of moveFeatures) {
    if (move.color !== playerColor) continue;
    // Phase 2a: likelyPremove's meaning changed (see extractFeatures.ts's
    // classifyMoveSpeed) but this check itself doesn't need to — a move
    // reaching here with likelyPremove === false now includes genuine snap
    // decisions (fast + complex position), which is exactly the unlock
    // Phase 2a asked for: they now fall through to the normal flagType
    // logic below instead of being excluded outright.
    if (move.likelyPremove || move.timeSpentSec === null || move.clockRemainingSec === null) continue;

    const evalPoint = evalByPly.get(move.ply);
    if (!evalPoint) continue;
    const resolved = resolveCpLoss(evalPoint);
    if (!resolved) continue; // no usable before/after comparison — still excluded
    const { cpLoss, evalConfidence } = resolved;
    if (cpLoss < MIN_CP_LOSS) continue; // not objectively a mistake — drop, don't flag

    const causality = checkCausality(gameEval, move.ply, playerColor);
    if (!causality.heldToEnd) continue; // recovered — doesn't fit any of the four types, drop per spec

    const phaseAvg = profile.avgMoveTimeSecByPhase[move.gamePhase];
    if (phaseAvg === null) continue;
    const timeRatio = move.timeSpentSec / phaseAvg;

    const matchedWeakness = weaknessProfile.patterns.find((p) =>
      p.occurrences.some((o) => o.gameId === move.gameId && o.ply === move.ply)
    );

    let flagType: FlaggedMove["flagType"];
    if (matchedWeakness && matchedWeakness.occurrences.length > 1) {
      flagType = "pattern_repeat";
    } else if (timeRatio < TIME_RATIO_COLLAPSE_THRESHOLD) {
      flagType = "collapse";
    } else if (timeRatio > TIME_RATIO_PARADOX_SLOW_THRESHOLD) {
      flagType = "time_paradox";
    } else {
      continue; // doesn't fit a type — drop, not a generic blunder flag
    }

    flagged.push(
      buildFlag(move, timeRatio, phaseAvg, cpLoss, causality, flagType, matchedWeakness?.id ?? null, evalConfidence)
    );
  }

  // Phase 2b: tilt-cascade detection is a second pass over the player's own
  // moves, independent of the per-move loop above (and NOT gated by
  // likelyPremove/timeSpentSec — the cascade signal is about a run of
  // declining positions, not about any one move's timing).
  flagged.push(...detectTiltCascades(moveFeatures, evalByPly, playerColor, gameEval, profile));

  return flagged.sort((a, b) => b.cpLoss - a.cpLoss);
}

/**
 * Phase 0/2 gap: resolves a move's cpLoss, now including the mate-only case
 * that used to be invisible to the flagger entirely (continue'd past
 * silently in flagMoves before this change). Returns null when there's no
 * usable comparison — same exclusion as before for that case.
 */
export function resolveCpLoss(evalPoint: EvalPoint): { cpLoss: number; evalConfidence: FlaggedMove["evalConfidence"] } | null {
  // Fully normal case: both sides are real cp numbers.
  if (evalPoint.cpBefore !== null && evalPoint.cpAfter !== null) {
    return { cpLoss: evalPoint.cpBefore - evalPoint.cpAfter, evalConfidence: "full" };
  }

  // Mate-only case: the move handed the opponent a forced mate. Arguably
  // the highest-severity collapse there is (per the Phase 0 audit note),
  // so it's treated as an enormous cpLoss rather than excluded outright.
  // Only the "walked into getting mated" direction counts — mateAfter is
  // already in the mover's POV (see evalCache.normalizeEvalPoint), so
  // negative means the MOVER faces forced mate. mateAfter positive (mover
  // delivers mate) is not a blunder and stays excluded, same as before.
  if (evalPoint.cpBefore !== null && evalPoint.cpAfter === null && evalPoint.mateAfter !== null && evalPoint.mateAfter < 0) {
    return { cpLoss: evalPoint.cpBefore - -MATE_EQUIVALENT_CP, evalConfidence: "mate_only" };
  }

  // evalConfidence "degraded" is reserved for a future lower-depth or
  // structurally-incomplete eval read — nothing in this function produces
  // it yet; there's no such signal available at this call site today.
  return null;
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
  gameEval: GameEval,
  profile: PlayerProfile
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
      if (!evalPoint || evalPoint.cpBefore === null || evalPoint.cpAfter === null) break;
      const cpLoss = evalPoint.cpBefore - evalPoint.cpAfter;
      if (cpLoss < CASCADE_PER_MOVE_MIN_CP_LOSS) break;
      totalLoss += cpLoss;
      runEnd++;
    }

    const runLength = runEnd - i;
    if (runLength >= CASCADE_MIN_LENGTH && totalLoss >= CASCADE_TOTAL_MIN_CP_LOSS) {
      const lastMove = ownMoves[runEnd - 1];
      const causality = checkCausality(gameEval, lastMove.ply, playerColor);
      if (causality.heldToEnd) {
        flagged.push(
          buildCascadeFlag(lastMove, ownMoves[i].ply, runLength, Math.round(totalLoss), causality, profile)
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
  causality: ReturnType<typeof checkCausality>,
  profile: PlayerProfile
): FlaggedMove {
  const phaseAvg = profile.avgMoveTimeSecByPhase[lastMove.gamePhase];
  const timeSpentSec = lastMove.timeSpentSec ?? 0;
  const timeRatio = phaseAvg !== null && phaseAvg > 0 ? timeSpentSec / phaseAvg : 0;

  const severityBreakdown = computeSeverityBreakdown({
    cpLoss: totalLossCp,
    flagType: "tilt_cascade",
    timeRatio,
    cascadeLength: sequenceLength,
  });

  return {
    gameId: lastMove.gameId, ply: lastMove.ply, moveNumber: lastMove.moveNumber, san: lastMove.san, color: lastMove.color,
    ratio: Number(timeRatio.toFixed(2)), clockRemainingSec: lastMove.clockRemainingSec ?? 0, gamePhase: lastMove.gamePhase,
    flagType: "tilt_cascade", timeSpentSec, phaseAvgSec: phaseAvg ?? 0, timeRatio: Number(timeRatio.toFixed(2)),
    cpLoss: totalLossCp, causality, matchedWeaknessId: null,
    styleDeviationScore: Math.min(1, Math.abs(1 - timeRatio)),
    absoluteAnomalyScore: Math.min(1, totalLossCp / 500),
    severity: severityFromBreakdown(severityBreakdown),
    severityBreakdown,
    pivotMove: null,
    cascadeMeta: { sequenceLength, depthCp: totalLossCp, startPly },
    evalConfidence: "full", // cascade detection only walks moves with real cp-before/after pairs
    explanation: `Lost ~${(totalLossCp / 100).toFixed(1)} pawns over ${sequenceLength} consecutive moves — a decline, not a single blunder.`,
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
    ratio: Number(timeRatio.toFixed(2)), clockRemainingSec: move.clockRemainingSec!, gamePhase: move.gamePhase,
    flagType, timeSpentSec: move.timeSpentSec!, phaseAvgSec: phaseAvg, timeRatio: Number(timeRatio.toFixed(2)),
    cpLoss: roundedCpLoss, causality, matchedWeaknessId: weaknessId,
    styleDeviationScore: Math.min(1, Math.abs(1 - timeRatio)),
    absoluteAnomalyScore: Math.min(1, cpLoss / 500),
    severity: severityFromBreakdown(severityBreakdown),
    severityBreakdown,
    pivotMove: null, // Phase 3
    cascadeMeta: null, // only tilt_cascade flags (built via buildCascadeFlag) carry this
    evalConfidence,
      explanation: explain(flagType, move, timeRatio, cpLoss),
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
  timeRatio: number;
  cascadeLength?: number;
}): FlaggedMove["severityBreakdown"] {
  const evalLoss = Math.round(opts.cpLoss);

  // A mistake the player has made before is more actionable/severe than an
  // isolated one-off — only pattern_repeat flags carry this.
  const patternMatchBonus = opts.flagType === "pattern_repeat" ? 75 : 0;

  // The faster relative to baseline (for a collapse flag specifically),
  // the more severe — scaled by how far under the ratio threshold it is,
  // capped so one extreme outlier can't dominate the score.
  const rushBonus =
    opts.flagType === "collapse" ? Math.round(Math.max(0, 1 - opts.timeRatio) * 100) : 0;

  // Tilt cascades get weight per extra move in the run beyond the minimum
  // length — a 4-move decline is more severe than a 2-move one even at the
  // same total cpLoss.
  const tiltBonus =
    opts.flagType === "tilt_cascade" && opts.cascadeLength
      ? Math.max(0, opts.cascadeLength - CASCADE_MIN_LENGTH) * 40
      : 0;

  return { evalLoss, patternMatchBonus, rushBonus, tiltBonus };
}

function severityFromBreakdown(b: FlaggedMove["severityBreakdown"]): "low" | "medium" | "high" {
  const score = b.evalLoss + b.patternMatchBonus + b.rushBonus + b.tiltBonus;
  // Same 300/150 cutoffs the old pure-cpLoss formula used — kept as-is so
  // a flag with zero bonuses buckets identically to before.
  return score > 300 ? "high" : score > 150 ? "medium" : "low";
}

function explain(flagType: FlaggedMove["flagType"], move: MoveFeature, timeRatio: number, cpLoss: number): string {
  const base = `Lost ~${(cpLoss / 100).toFixed(1)} pawns of eval, deficit never recovered.`;
  if (flagType === "collapse") return `${base} Played in ${move.timeSpentSec?.toFixed(1)}s — ${(timeRatio * 100).toFixed(0)}% of your usual time here.`;
  if (flagType === "time_paradox") return `${base} Took ${(timeRatio * 100).toFixed(0)}% longer than usual and was still wrong.`;
  return `${base} Matches a pattern seen elsewhere in your games.`;
}
