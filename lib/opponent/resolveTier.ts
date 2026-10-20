export type OpponentTier = 1 | 2 | 3;

export interface TierInputs {
  effectiveRatingFires: boolean;
  openingTreeHits: number;
  pieceActivityConfidence: "low" | "medium" | "high" | null;
}

export interface TierResult {
  tier: OpponentTier;
  firedSignals: string[];
}

const MIN_OPENING_OCCURRENCES = 3;

export function resolveOpponentTier({ effectiveRatingFires, openingTreeHits, pieceActivityConfidence }: TierInputs): TierResult {
  const openingFires = openingTreeHits >= MIN_OPENING_OCCURRENCES;
  const pieceFires = pieceActivityConfidence === "medium" || pieceActivityConfidence === "high";
  const fired: string[] = [];
  if (effectiveRatingFires) fired.push("effective rating");
  if (openingFires) fired.push("opening tree");
  if (pieceFires) fired.push("piece activity");

  if (effectiveRatingFires && (openingFires || pieceFires)) return { tier: 1, firedSignals: fired };
  const otherDataExists = openingTreeHits > 0 || pieceActivityConfidence !== null;
  if (effectiveRatingFires && otherDataExists) return { tier: 2, firedSignals: fired };
  return { tier: 3, firedSignals: fired };
}
