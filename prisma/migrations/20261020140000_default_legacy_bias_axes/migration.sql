-- Keep legacy aggregate columns for backward compatibility, but default them
-- so new BiasProfile rows only need to persist the squareBias source of truth.
ALTER TABLE "BiasProfile"
  ALTER COLUMN "rankBias" SET DEFAULT '{}'::jsonb,
  ALTER COLUMN "fileBias" SET DEFAULT '{}'::jsonb,
  ALTER COLUMN "diagonalBias" SET DEFAULT '{}'::jsonb;
