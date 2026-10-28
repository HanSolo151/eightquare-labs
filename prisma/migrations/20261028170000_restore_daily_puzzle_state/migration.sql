-- The migration history says this table was created, but it is absent from
-- the live database. Recreate it without touching resolved spar positions.
CREATE TABLE IF NOT EXISTS "DailyPuzzleState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "ply" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "lastSkippedAt" TIMESTAMP(3),
    "solvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyPuzzleState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DailyPuzzleState_userId_gameId_ply_key"
ON "DailyPuzzleState"("userId", "gameId", "ply");

CREATE INDEX IF NOT EXISTS "DailyPuzzleState_userId_status_idx"
ON "DailyPuzzleState"("userId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DailyPuzzleState_userId_fkey'
      AND conrelid = '"DailyPuzzleState"'::regclass
  ) THEN
    ALTER TABLE "DailyPuzzleState"
    ADD CONSTRAINT "DailyPuzzleState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
