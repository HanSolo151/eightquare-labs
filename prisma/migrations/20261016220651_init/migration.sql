-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "lichessId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastGameCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerColor" TEXT NOT NULL,
    "opponentUsername" TEXT NOT NULL,
    "opponentRating" INTEGER,
    "playerRating" INTEGER,
    "moves" JSONB NOT NULL,
    "clocks" JSONB,
    "openingName" TEXT,
    "openingEco" TEXT,
    "result" TEXT NOT NULL,
    "rated" BOOLEAN NOT NULL,
    "speed" TEXT,
    "lichessCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEval" (
    "gameId" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEval_pkey" PRIMARY KEY ("gameId")
);

-- CreateTable
CREATE TABLE "FlaggedMove" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "ply" INTEGER NOT NULL,
    "moveNumber" INTEGER NOT NULL,
    "san" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "flagType" TEXT NOT NULL,
    "timeSpentSec" DOUBLE PRECISION NOT NULL,
    "phaseAvgSec" DOUBLE PRECISION NOT NULL,
    "timeRatio" DOUBLE PRECISION NOT NULL,
    "clockRemainingSec" DOUBLE PRECISION NOT NULL,
    "gamePhase" TEXT NOT NULL,
    "cpLoss" DOUBLE PRECISION NOT NULL,
    "causality" JSONB NOT NULL,
    "matchedWeaknessId" TEXT,
    "styleDeviationScore" DOUBLE PRECISION NOT NULL,
    "absoluteAnomalyScore" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "severityBreakdown" JSONB NOT NULL,
    "pivotMove" JSONB,
    "cascadeMeta" JSONB,
    "evalConfidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "FlaggedMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerProfile" (
    "userId" TEXT NOT NULL,
    "gamesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "avgMoveTimeSecByPhase" JSONB NOT NULL,
    "premoveRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mostCommonOpenings" JSONB NOT NULL,
    "avgOpponentRating" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "WeaknessProfileRow" (
    "userId" TEXT NOT NULL,
    "patterns" JSONB NOT NULL,
    "evaluatedGameIds" JSONB NOT NULL,
    "gamesEvaluated" INTEGER NOT NULL DEFAULT 0,
    "gamesFetched" INTEGER NOT NULL DEFAULT 0,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeaknessProfileRow_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "BiasProfile" (
    "userId" TEXT NOT NULL,
    "rankBias" JSONB NOT NULL,
    "fileBias" JSONB NOT NULL,
    "diagonalBias" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiasProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_lichessId_key" ON "User"("lichessId");

-- CreateIndex
CREATE INDEX "Game_userId_idx" ON "Game"("userId");

-- CreateIndex
CREATE INDEX "Game_userId_lichessCreatedAt_idx" ON "Game"("userId", "lichessCreatedAt");

-- CreateIndex
CREATE INDEX "FlaggedMove_gameId_idx" ON "FlaggedMove"("gameId");

-- CreateIndex
CREATE INDEX "FlaggedMove_matchedWeaknessId_idx" ON "FlaggedMove"("matchedWeaknessId");

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEval" ADD CONSTRAINT "GameEval_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlaggedMove" ADD CONSTRAINT "FlaggedMove_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerProfile" ADD CONSTRAINT "PlayerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeaknessProfileRow" ADD CONSTRAINT "WeaknessProfileRow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiasProfile" ADD CONSTRAINT "BiasProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
