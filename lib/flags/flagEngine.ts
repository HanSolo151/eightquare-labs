import type { MoveFeature, PlayerProfile, WeaknessProfile, GameEval, FlaggedMove } from "@/types";
import { checkCausality } from "./causality";

const TIME_RATIO_COLLAPSE_THRESHOLD = 0.35;
const TIME_RATIO_PARADOX_SLOW_THRESHOLD = 1.8; // "spent way more time than usual and still got it wrong"
const MIN_CP_LOSS = 100;

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
    if (move.likelyPremove || move.timeSpentSec === null || move.clockRemainingSec === null) continue;

    const evalPoint = evalByPly.get(move.ply);
    if (!evalPoint || evalPoint.cpBefore === null || evalPoint.cpAfter === null) continue;

    // evalCache stores each point from that move's mover perspective. Since
    // this feature is the player's move, these values are already in their POV.
    const cpLoss = evalPoint.cpBefore - evalPoint.cpAfter;
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

    flagged.push(buildFlag(move, timeRatio, phaseAvg, cpLoss, causality, flagType, matchedWeakness?.id ?? null));
  }

  return flagged.sort((a, b) => b.cpLoss - a.cpLoss);
}

function buildFlag(
  move: MoveFeature, timeRatio: number, phaseAvg: number, cpLoss: number,
  causality: ReturnType<typeof checkCausality>, flagType: FlaggedMove["flagType"], weaknessId: string | null
): FlaggedMove {
  const severity = cpLoss > 300 ? "high" : cpLoss > 150 ? "medium" : "low";
  return {
    gameId: move.gameId, ply: move.ply, moveNumber: move.moveNumber, san: move.san, color: move.color,
    ratio: Number(timeRatio.toFixed(2)), clockRemainingSec: move.clockRemainingSec!, gamePhase: move.gamePhase,
    flagType, timeSpentSec: move.timeSpentSec!, phaseAvgSec: phaseAvg, timeRatio: Number(timeRatio.toFixed(2)),
    cpLoss: Math.round(cpLoss), causality, matchedWeaknessId: weaknessId,
    styleDeviationScore: Math.min(1, Math.abs(1 - timeRatio)),
    absoluteAnomalyScore: Math.min(1, cpLoss / 500),
    severity,
    explanation: explain(flagType, move, timeRatio, cpLoss, causality),
  };
}

function explain(flagType: FlaggedMove["flagType"], move: MoveFeature, timeRatio: number, cpLoss: number, causality: ReturnType<typeof checkCausality>): string {
  const base = `Lost ~${(cpLoss / 100).toFixed(1)} pawns of eval, deficit never recovered.`;
  if (flagType === "collapse") return `${base} Played in ${move.timeSpentSec?.toFixed(1)}s — ${(timeRatio * 100).toFixed(0)}% of your usual time here.`;
  if (flagType === "time_paradox") return `${base} Took ${(timeRatio * 100).toFixed(0)}% longer than usual and was still wrong.`;
  return `${base} Matches a pattern seen elsewhere in your games.`;
}