ALTER TABLE "GameMoment" ADD COLUMN "ply" INTEGER;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "gameId" ORDER BY "createdAt", "id") - 1 AS "ply"
  FROM "GameMoment"
)
UPDATE "GameMoment" AS moment SET "ply" = ranked."ply"
FROM ranked WHERE moment."id" = ranked."id";

ALTER TABLE "GameMoment" ALTER COLUMN "ply" SET NOT NULL;

CREATE UNIQUE INDEX "GameMoment_userId_gameId_ply_key"
ON "GameMoment"("userId", "gameId", "ply");

ALTER TABLE "GameMoment"
ADD COLUMN "deepLinkTokenHash" TEXT,
ADD COLUMN "deepLinkExpiresAt" TIMESTAMP(3),
ADD COLUMN "sendClaimedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "GameMoment_deepLinkTokenHash_key"
ON "GameMoment"("deepLinkTokenHash");

ALTER TABLE "EmailSendLog"
ADD CONSTRAINT "EmailSendLog_gameMomentId_fkey"
FOREIGN KEY ("gameMomentId") REFERENCES "GameMoment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
