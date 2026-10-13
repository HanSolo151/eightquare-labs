import type { WeaknessProfile, WeaknessPattern, GameEval, MoveFeature, CausalityVerdict } from "@/types";
import { checkCausality } from "../flags/causality";

const MIN_CP_LOSS_FOR_CANDIDATE = 100; // half-pawn-plus swing, tunable

// Coarse tagging — this is deliberately simple for v1. Richer tactical-motif
// detection (fork missed, back-rank issue, etc.) is a later pass; for now we
// bucket by phase + material trend, which is enough to find "this keeps
// happening in X kind of position" without a full motif classifier.
function tagForPosition(ply: number, phase: MoveFeature["gamePhase"]): string[] {
  return [phase];
}

/**
 * Scans one evaluated game for candidate weakness occurrences and folds them
 * into an existing profile. Called once per game as its eval becomes
 * available (background batch on first load, or on-demand when opened) —
 * never recomputed from scratch, per the caching decision.
 */
export function updateWeaknessProfile(
  profile: WeaknessProfile,
  gameId: string,
  gameEval: GameEval,
  moveFeatures: MoveFeature[],
  playerColor: "white" | "black"
): WeaknessProfile {
  profile.evaluatedGameIds ??= [];
  if (profile.evaluatedGameIds.includes(gameId)) return profile;

  const featByPly = new Map(moveFeatures.map((f) => [f.ply, f]));

  for (const point of gameEval.points) {
    const feat = featByPly.get(point.ply);
    if (!feat || feat.color !== playerColor) continue;
    if (point.cpBefore === null || point.cpAfter === null) continue;

    // Eval points are already normalized to the mover's perspective.
    const cpLoss = point.cpBefore - point.cpAfter;
    if (cpLoss < MIN_CP_LOSS_FOR_CANDIDATE) continue;

    const causality: CausalityVerdict = checkCausality(gameEval, point.ply, playerColor);
    if (!causality.heldToEnd) continue; // recovered — not a real weakness instance

    const tags = tagForPosition(point.ply, feat.gamePhase);
    const existing = profile.patterns.find((p) => sameTagSet(p.tags, tags));

    if (existing) {
      existing.occurrences.push({ gameId, ply: point.ply });
      existing.lastSeenAt = Date.now();
    } else {
      profile.patterns.push({
        id: `${tags.join("-")}-${Date.now()}`,
        description: describePattern(tags),
        occurrences: [{ gameId, ply: point.ply }],
        tags,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    }
  }

  profile.evaluatedGameIds.push(gameId);
  profile.gamesEvaluated++;
  profile.confidence = profile.gamesEvaluated >= 15 ? "high" : profile.gamesEvaluated >= 5 ? "medium" : "low";
  profile.builtAt = Date.now();
  return profile;
}

function sameTagSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

function describePattern(tags: string[]): string {
  return `Recurring eval collapses in the ${tags.join(", ")}`;
}