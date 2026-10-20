CREATE TABLE "DailyPuzzleState" (
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

CREATE UNIQUE INDEX "DailyPuzzleState_userId_gameId_ply_key"
ON "DailyPuzzleState"("userId", "gameId", "ply");

CREATE INDEX "DailyPuzzleState_userId_status_idx"
ON "DailyPuzzleState"("userId", "status");

ALTER TABLE "DailyPuzzleState"
ADD CONSTRAINT "DailyPuzzleState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
