import { MATCHING_CONFIG } from "@/config/matching";
import type { MatchSoundness } from "./gates";

export interface RerankCandidate {
  id: string;
  matchedBigshotId: string;
  matchDistance: number;
  motifMatch: boolean;
  soundness: MatchSoundness;
  sampleSize: number;
  createdAt: Date;
}

export interface ScoredCandidate extends RerankCandidate {
  rerankScore: number;
}

export interface RerankSelection {
  selected: ScoredCandidate[];
  expiredIds: string[];
  ranked: ScoredCandidate[];
}

/**
 * Higher scores favor close matches, a tagged motif, sound play and broader
 * corpus support; recent repeats receive a modest penalty. Corpus size stays
 * a small tiebreaker rather than dominating vector distance.
 */
export function scoreRerankCandidate(candidate: RerankCandidate, recentBigshotIds: ReadonlySet<string>): number {
  const distance = Math.max(0, candidate.matchDistance);
  const base = 1 / (MATCHING_CONFIG.RERANK_DISTANCE_EPSILON + distance);
  const soundMultiplier = candidate.soundness === "sound"
    ? MATCHING_CONFIG.RERANK_SOUND_MULTIPLIER
    : candidate.soundness === "unverified"
      ? MATCHING_CONFIG.RERANK_UNVERIFIED_MULTIPLIER
      : MATCHING_CONFIG.RERANK_UNSOUND_MULTIPLIER;
  const confidenceRatio = Math.max(0, candidate.sampleSize - MATCHING_CONFIG.BIGSHOT_MIN_GAMES)
    / MATCHING_CONFIG.RERANK_SAMPLE_CONFIDENCE_GAMES;
  const confidenceMultiplier = 1 + Math.min(MATCHING_CONFIG.RERANK_SAMPLE_CONFIDENCE_CAP, confidenceRatio);
  const motifMultiplier = candidate.motifMatch ? MATCHING_CONFIG.RERANK_MOTIF_MULTIPLIER : 1;
  const repeatMultiplier = recentBigshotIds.has(candidate.matchedBigshotId)
    ? MATCHING_CONFIG.RERANK_RECENT_REPEAT_MULTIPLIER
    : 1;
  return base * soundMultiplier * confidenceMultiplier * motifMultiplier * repeatMultiplier;
}

export function selectRerankCandidates(
  candidates: RerankCandidate[],
  sendsInRollingWindow: number,
  recentBigshotIds: ReadonlySet<string>,
  now = new Date(),
): RerankSelection {
  const backlogCutoff = now.getTime() - MATCHING_CONFIG.RERANK_BACKLOG_DAYS * 24 * 60 * 60 * 1000;
  const expiredIds = candidates.filter((candidate) => candidate.createdAt.getTime() < backlogCutoff).map((candidate) => candidate.id);
  const ranked = candidates
    .filter((candidate) => candidate.createdAt.getTime() >= backlogCutoff)
    .map((candidate) => ({ ...candidate, rerankScore: scoreRerankCandidate(candidate, recentBigshotIds) }))
    .sort((a, b) => b.rerankScore - a.rerankScore || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const available = Math.max(0, MATCHING_CONFIG.MAX_EMAILS_PER_WEEK - sendsInRollingWindow);
  return { selected: ranked.slice(0, available), expiredIds, ranked };
}
