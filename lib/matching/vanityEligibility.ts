import { MATCHING_CONFIG } from "@/config/matching";
import type { ParsedGame } from "@/types";

export function isVanityEvaluationEligible(game: Pick<ParsedGame, "rated" | "result" | "speed">): boolean {
  if (MATCHING_CONFIG.VANITY_REQUIRE_RATED && !game.rated) return false;
  if (game.result !== MATCHING_CONFIG.VANITY_ELIGIBLE_RESULT) return false;
  const eligibleSpeeds = MATCHING_CONFIG.VANITY_ELIGIBLE_SPEEDS;
  return eligibleSpeeds === null || (game.speed !== null && (eligibleSpeeds as readonly string[]).includes(game.speed));
}
