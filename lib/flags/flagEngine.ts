import { MoveFeature, PlayerProfile, FlaggedMove } from "@/types";

const TIME_RATIO_THRESHOLD = 0.6;
const MIN_CLOCK_REMAINING_SEC = 90;
const MIN_MOVE_NUMBER = 10;
const MAX_MOVE_NUMBER = 30;
const PREMOVE_RATE_WARNING_THRESHOLD = 0.6;

export function flagMoves(
  moveFeatures: MoveFeature[],
  profile: PlayerProfile
): FlaggedMove[] {
  const flagged: FlaggedMove[] = [];

  for (const move of moveFeatures) {
    if (move.likelyPremove) continue;
    if (move.timeSpentSec === null) continue;
    if (move.isForcing) continue;
    if (move.moveNumber < MIN_MOVE_NUMBER || move.moveNumber > MAX_MOVE_NUMBER) continue;
    if (move.clockRemainingSec === null || move.clockRemainingSec <= MIN_CLOCK_REMAINING_SEC) continue;

    const phaseAvg = profile.avgMoveTimeSecByPhase[move.gamePhase];
    if (phaseAvg === null || phaseAvg === undefined) continue;

    const ratio = move.timeSpentSec / phaseAvg;

    if (ratio < TIME_RATIO_THRESHOLD) {
      flagged.push({
        gameId: move.gameId,
        ply: move.ply,
        moveNumber: move.moveNumber,
        san: move.san,
        timeSpentSec: move.timeSpentSec,
        phaseAvgSec: phaseAvg,
        ratio: Number(ratio.toFixed(3)),
        clockRemainingSec: move.clockRemainingSec,
        gamePhase: move.gamePhase,
        severity: computeSeverity(ratio),
      });
    }
  }

  flagged.sort((a, b) => a.ratio - b.ratio);
  return flagged;
}

function computeSeverity(ratio: number): "low" | "medium" | "high" {
  if (ratio < 0.25) return "high";
  if (ratio < 0.45) return "medium";
  return "low";
}

export function checkProfileWarnings(profile: PlayerProfile): string[] {
  const warnings: string[] = [];
  if (profile.premoveRate > PREMOVE_RATE_WARNING_THRESHOLD) {
    warnings.push(
      `premoveRate is ${(profile.premoveRate * 100).toFixed(1)}% — sample may be small/noisy.`
    );
  }
  return warnings;
}