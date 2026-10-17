-- Lichess game IDs are public and one game may belong to multiple accounts.
-- Give each stored user/game pair an internal identity while preserving the
-- external ID used by the client and Lichess.

ALTER TABLE "Game" ADD COLUMN "lichessGameId" TEXT;
ALTER TABLE "Game" ADD COLUMN "internalId" TEXT;

UPDATE "Game"
SET "lichessGameId" = "id",
    "internalId" = gen_random_uuid()::text;

ALTER TABLE "Game" ALTER COLUMN "lichessGameId" SET NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "internalId" SET NOT NULL;

ALTER TABLE "GameEval" DROP CONSTRAINT "GameEval_gameId_fkey";
ALTER TABLE "FlaggedMove" DROP CONSTRAINT "FlaggedMove_gameId_fkey";

UPDATE "GameEval" AS evaluation
SET "gameId" = game."internalId"
FROM "Game" AS game
WHERE evaluation."gameId" = game."id";

UPDATE "FlaggedMove" AS flag
SET "gameId" = game."internalId"
FROM "Game" AS game
WHERE flag."gameId" = game."id";

ALTER TABLE "Game" DROP CONSTRAINT "Game_pkey";
ALTER TABLE "Game" DROP COLUMN "id";
ALTER TABLE "Game" RENAME COLUMN "internalId" TO "id";
ALTER TABLE "Game" ADD CONSTRAINT "Game_pkey" PRIMARY KEY ("id");
ALTER TABLE "Game" ADD CONSTRAINT "Game_userId_lichessGameId_key"
  UNIQUE ("userId", "lichessGameId");

ALTER TABLE "GameEval" ADD CONSTRAINT "GameEval_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FlaggedMove" ADD CONSTRAINT "FlaggedMove_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
