// Relative, within-account score. It combines move-level cp loss, loss rate,
// and flag density; it must not be read as an absolute prediction of danger.
export interface OpeningRaw {
  avgCpLoss: number;
  lossRate: number;
  flagDensity: number;
}

export type DangerBadge = "danger" | "shaky" | "safe";

function normalize(values: number[]): (value: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max === min ? () => 0.5 : (value) => (value - min) / (max - min);
}

export function computeDangerScores<T extends OpeningRaw>(
  openings: T[]
): (T & { dangerScore: number; badge: DangerBadge })[] {
  if (openings.length === 0) return [];
  const cp = normalize(openings.map((opening) => opening.avgCpLoss));
  const losses = normalize(openings.map((opening) => opening.lossRate));
  const density = normalize(openings.map((opening) => opening.flagDensity));
  const scored = openings.map((opening) => ({
    ...opening,
    dangerScore: (cp(opening.avgCpLoss) + losses(opening.lossRate) + density(opening.flagDensity)) / 3,
  }));

  // Assign tied scores together. In particular, a flat dataset is "shaky"
  // across the board rather than incorrectly labeling every opening danger.
  const distinct = [...new Set(scored.map((opening) => opening.dangerScore))].sort((a, b) => a - b);
  const badgeFor = (score: number): DangerBadge => {
    if (distinct.length < 2) return "shaky";
    const rank = distinct.indexOf(score) / (distinct.length - 1);
    return rank >= 2 / 3 ? "danger" : rank <= 1 / 3 ? "safe" : "shaky";
  };
  return scored.map((opening) => ({ ...opening, badge: badgeFor(opening.dangerScore) }));
}
