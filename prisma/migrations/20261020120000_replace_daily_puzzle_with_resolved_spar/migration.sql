CREATE TABLE "ResolvedSparPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "ply" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolvedSparPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResolvedSparPosition_userId_gameId_ply_key"
ON "ResolvedSparPosition"("userId", "gameId", "ply");

CREATE INDEX "ResolvedSparPosition_userId_idx"
ON "ResolvedSparPosition"("userId");

CREATE INDEX "ResolvedSparPosition_gameId_idx"
ON "ResolvedSparPosition"("gameId");

INSERT INTO "ResolvedSparPosition" ("id", "userId", "gameId", "ply", "resolvedAt")
SELECT
  'srp_' || md5(daily."userId" || ':' || daily."gameId" || ':' || daily."ply"::text),
  daily."userId",
  daily."gameId",
  daily."ply",
  COALESCE(daily."solvedAt", CURRENT_TIMESTAMP)
FROM "DailyPuzzleState" AS daily
INNER JOIN "Game" AS game ON game."id" = daily."gameId" AND game."userId" = daily."userId"
WHERE daily."status" = 'solved'
ON CONFLICT ("userId", "gameId", "ply") DO NOTHING;

ALTER TABLE "ResolvedSparPosition"
ADD CONSTRAINT "ResolvedSparPosition_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResolvedSparPosition"
ADD CONSTRAINT "ResolvedSparPosition_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

