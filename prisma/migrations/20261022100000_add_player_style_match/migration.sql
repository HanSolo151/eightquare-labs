CREATE TABLE "Bigshot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gameCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Bigshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BigshotPhaseProfile" (
    "id" TEXT NOT NULL,
    "bigshotId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "vector" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    CONSTRAINT "BigshotPhaseProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BigshotVectorCalibration" (
    "id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "means" JSONB NOT NULL,
    "stdDevs" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BigshotVectorCalibration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BigshotSampleGame" (
    "id" TEXT NOT NULL,
    "bigshotId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "pgn" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "attribution" TEXT,
    "motifTag" TEXT,
    "featureDetails" JSONB,
    CONSTRAINT "BigshotSampleGame_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GameMoment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "moveNumber" INTEGER NOT NULL,
    "san" TEXT NOT NULL,
    "fenBeforeMove" TEXT NOT NULL,
    "evalBefore" DOUBLE PRECISION,
    "evalAfter" DOUBLE PRECISION,
    "soundness" TEXT NOT NULL DEFAULT 'unverified',
    "matchedBigshotId" TEXT,
    "matchDistance" DOUBLE PRECISION,
    "motifMatch" BOOLEAN NOT NULL DEFAULT false,
    "sampleGameId" TEXT,
    "rerankScore" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "feedback" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameMoment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vanityMatchOptIn" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribeToken" TEXT NOT NULL,
    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSendLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameMomentId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailSendLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Bigshot_name_key" ON "Bigshot"("name");
CREATE UNIQUE INDEX "BigshotPhaseProfile_bigshotId_phase_key" ON "BigshotPhaseProfile"("bigshotId", "phase");
CREATE UNIQUE INDEX "BigshotVectorCalibration_phase_key" ON "BigshotVectorCalibration"("phase");
CREATE INDEX "BigshotSampleGame_bigshotId_phase_idx" ON "BigshotSampleGame"("bigshotId", "phase");
CREATE INDEX "GameMoment_userId_status_createdAt_idx" ON "GameMoment"("userId", "status", "createdAt");
CREATE INDEX "GameMoment_gameId_idx" ON "GameMoment"("gameId");
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");
CREATE UNIQUE INDEX "NotificationPreference_unsubscribeToken_key" ON "NotificationPreference"("unsubscribeToken");
CREATE UNIQUE INDEX "EmailSendLog_gameMomentId_key" ON "EmailSendLog"("gameMomentId");
CREATE INDEX "EmailSendLog_userId_sentAt_idx" ON "EmailSendLog"("userId", "sentAt");

ALTER TABLE "BigshotPhaseProfile" ADD CONSTRAINT "BigshotPhaseProfile_bigshotId_fkey"
FOREIGN KEY ("bigshotId") REFERENCES "Bigshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BigshotSampleGame" ADD CONSTRAINT "BigshotSampleGame_bigshotId_fkey"
FOREIGN KEY ("bigshotId") REFERENCES "Bigshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameMoment" ADD CONSTRAINT "GameMoment_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameMoment" ADD CONSTRAINT "GameMoment_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameMoment" ADD CONSTRAINT "GameMoment_matchedBigshotId_fkey"
FOREIGN KEY ("matchedBigshotId") REFERENCES "Bigshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailSendLog" ADD CONSTRAINT "EmailSendLog_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
