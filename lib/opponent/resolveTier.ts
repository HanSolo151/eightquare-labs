export type OpponentTier = 1 | 2 | 3;

export interface TierInputs {
  effectiveRatingFires: boolean;
  openingTreeHits: number;
  opponentGamesAnalyzed: number;
}

export interface TierResult {
  tier: OpponentTier;
  firedSignals: string[];
}

const MIN_OPENING_OCCURRENCES = 3;

export function resolveOpponentTier({ effectiveRatingFires, openingTreeHits, opponentGamesAnalyzed }: TierInputs): TierResult {
  const openingFires = openingTreeHits >= MIN_OPENING_OCCURRENCES;
  const behaviorFires = opponentGamesAnalyzed >= 5;
  const fired: string[] = [];
  if (effectiveRatingFires) fired.push("effective rating");
  if (openingFires) fired.push("opening tree");
  if (behaviorFires) fired.push("move tendencies");

  if (effectiveRatingFires && (openingFires || behaviorFires)) return { tier: 1, firedSignals: fired };
  const otherDataExists = openingTreeHits > 0 || opponentGamesAnalyzed > 0;
  if (effectiveRatingFires && otherDataExists) return { tier: 2, firedSignals: fired };
  return { tier: 3, firedSignals: fired };
}
