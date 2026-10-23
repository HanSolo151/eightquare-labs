import { isStyleVector, type MatchPhase, type StyleVector } from "./vectorSchema";

export interface BigshotCandidate {
  bigshotId: string;
  phase: MatchPhase;
  vector: unknown;
  motifMatch?: boolean;
}

export interface BigshotMatch {
  bigshotId: string;
  distance: number;
  motifMatch: boolean;
}

/**
 * Euclidean distance is used because all dimensions are z-scored against the
 * same phase corpus before comparison; each dimension therefore has equal
 * scale. Revisit if §6 reviewer feedback shows a scale or correlation issue.
 */
export function findNearestBigshots(
  vector: StyleVector,
  phase: MatchPhase,
  candidates: BigshotCandidate[],
  excludeIds: string[] = [],
): BigshotMatch[] {
  if (!isStyleVector(vector)) return [];
  const excluded = new Set(excludeIds);
  return candidates
    .filter((candidate) => candidate.phase === phase && !excluded.has(candidate.bigshotId) && isStyleVector(candidate.vector))
    .map((candidate) => ({
      bigshotId: candidate.bigshotId,
      distance: euclideanDistance(vector, candidate.vector as StyleVector),
      motifMatch: candidate.motifMatch ?? false,
    }))
    .sort((a, b) => a.distance - b.distance || a.bigshotId.localeCompare(b.bigshotId));
}

function euclideanDistance(a: StyleVector, b: StyleVector): number {
  const keys = Object.keys(a) as (keyof StyleVector)[];
  return Math.sqrt(keys.reduce((total, key) => total + (a[key] - b[key]) ** 2, 0));
}
