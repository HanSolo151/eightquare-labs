// Ported from Step 1's utils.create_elo_dict() — 11 buckets, indices 0-10.
const ELO_BUCKET_BOUNDARIES = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000];

/** Converts a raw Elo rating into the 0-10 bucket index Maia-2 expects. */
export function eloToBucket(rating: number | null | undefined): number {
  if (rating == null || Number.isNaN(rating)) {
    // No rating available (e.g. unrated opponent data gap) — fall back to
    // the middle bucket rather than crashing the worker on a bad input.
    return 5;
  }
  for (let i = 0; i < ELO_BUCKET_BOUNDARIES.length; i++) {
    if (rating < ELO_BUCKET_BOUNDARIES[i]) return i;
  }
  return 10; // >= 2000
}