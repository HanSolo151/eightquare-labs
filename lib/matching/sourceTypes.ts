export const BIGSHOT_SOURCE_TYPES = [
  "lichess_cc0",
  "lichess_broadcast_ccbysa",
  "historical_public_domain",
  "operator_provided",
] as const;

export type BigshotSourceType = (typeof BIGSHOT_SOURCE_TYPES)[number];
