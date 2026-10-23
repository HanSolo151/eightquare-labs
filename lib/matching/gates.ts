import { MATCHING_CONFIG } from "../../config/matching";
import type { BigshotMatch } from "./profileMatcher";
import type { MatchPhase } from "./vectorSchema";

export type MatchSoundness = "sound" | "unsound_lucky" | "unverified";

export type GateFailureReason = "result_excluded" | "no_match" | "corpus_below_floor";

export interface RecentBigshotMoment {
  matchedBigshotId: string | null;
  createdAt: Date;
}

export interface PhaseCorpusProfile {
  bigshotId?: string;
  phase: MatchPhase;
  sampleSize: number;
}

function corpusProfile(
  profiles: MatchGateInput["profilesByBigshotId"],
  bigshotId: string,
  phase: MatchPhase,
): PhaseCorpusProfile | undefined {
  return profiles[`${bigshotId}:${phase}`] ?? profiles[bigshotId];
}

export type GateDecision<T> =
  | { pass: true; value: T }
  | { pass: false; reason: GateFailureReason };

export interface GatedMatch {
  match: BigshotMatch;
  soundness: MatchSoundness;
}

export interface MatchGateInput {
  result: "win" | "loss" | "draw";
  evalBefore: number | null;
  evalAfter: number | null;
  phase: MatchPhase;
  /** Called only after the game result passes the first gate. */
  findMatches: () => BigshotMatch[];
  profilesByBigshotId: Record<string, PhaseCorpusProfile | undefined>;
  recentMoments: RecentBigshotMoment[];
  now?: Date;
}

/** Result gate runs before matching so excluded results do no ranking work. */
export function passesResultGate(result: MatchGateInput["result"]): boolean {
  if (result === "win") return true;
  return result === "draw" && MATCHING_CONFIG.INCLUDE_DRAW_RESULTS;
}

/** Eval inputs are in pawn units from the player's perspective. */
export function classifySoundness(evalBefore: number | null, evalAfter: number | null): MatchSoundness {
  if (!Number.isFinite(evalBefore) || !Number.isFinite(evalAfter)) return "unverified";
  const evalDrop = evalBefore! - evalAfter!;
  return evalDrop > MATCHING_CONFIG.SOUNDNESS_EVAL_THRESHOLD ? "unsound_lucky" : "sound";
}

export function passesCorpusFloor(
  profile: PhaseCorpusProfile | undefined,
  phase: MatchPhase,
): boolean {
  return Boolean(profile && profile.phase === phase && profile.sampleSize >= MATCHING_CONFIG.BIGSHOT_MIN_GAMES);
}

/**
 * Repeats are demoted only when the next ranked, corpus-qualified profile is
 * within the configured relative distance margin of the best match.
 */
export function applyVarietyGate(
  matches: BigshotMatch[],
  phase: MatchPhase,
  profilesByBigshotId: MatchGateInput["profilesByBigshotId"],
  recentMoments: RecentBigshotMoment[],
  now: Date = new Date(),
): GateDecision<BigshotMatch> {
  const top = matches[0];
  if (!top) return { pass: false, reason: "no_match" };

  const recentCutoff = now.getTime() - MATCHING_CONFIG.VARIETY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const recentIds = recentMoments
    .filter((moment) => moment.matchedBigshotId && moment.createdAt.getTime() >= recentCutoff && moment.createdAt.getTime() <= now.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MATCHING_CONFIG.VARIETY_LOOKBACK_COUNT)
    .map((moment) => moment.matchedBigshotId);

  if (!recentIds.includes(top.bigshotId)) return { pass: true, value: top };

  const maximumAlternativeDistance = top.distance * (1 + MATCHING_CONFIG.VARIETY_MARGIN_PCT);
  const next = matches[1];
  const shouldDemote = next
    && next.distance <= maximumAlternativeDistance
    && passesCorpusFloor(corpusProfile(profilesByBigshotId, next.bigshotId, phase), phase);
  return { pass: true, value: shouldDemote ? next : top };
}

/** Applies result, soundness, corpus-floor, then variety logic in spec order. */
export function gateBigshotMatch(input: MatchGateInput): GateDecision<GatedMatch> {
  if (!passesResultGate(input.result)) return { pass: false, reason: "result_excluded" };

  const soundness = classifySoundness(input.evalBefore, input.evalAfter);
  const matches = input.findMatches();
  const top = matches[0];
  if (!top) return { pass: false, reason: "no_match" };

  if (!passesCorpusFloor(corpusProfile(input.profilesByBigshotId, top.bigshotId, input.phase), input.phase)) {
    return { pass: false, reason: "corpus_below_floor" };
  }

  const variety = applyVarietyGate(
    matches,
    input.phase,
    input.profilesByBigshotId,
    input.recentMoments,
    input.now,
  );
  if (!variety.pass) return variety;
  return { pass: true, value: { match: variety.value, soundness } };
}
