ALTER TABLE "Game" ADD COLUMN "clockInitialSec" DOUBLE PRECISION, ADD COLUMN "clockIncrementSec" DOUBLE PRECISION;

CREATE TABLE "VanityEvaluationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "checkpoint" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VanityEvaluationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VanityEvaluationJob_gameId_key" ON "VanityEvaluationJob"("gameId");
CREATE INDEX "VanityEvaluationJob_status_availableAt_idx" ON "VanityEvaluationJob"("status", "availableAt");
CREATE INDEX "VanityEvaluationJob_userId_status_idx" ON "VanityEvaluationJob"("userId", "status");

ALTER TABLE "VanityEvaluationJob" ADD CONSTRAINT "VanityEvaluationJob_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VanityEvaluationJob" ADD CONSTRAINT "VanityEvaluationJob_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
