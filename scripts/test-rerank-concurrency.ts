import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deliverPlayerStyleMatches } from "../lib/matching/deliverMatches";
import { prisma } from "../lib/prisma";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { lichessId: `match-cap-${suffix}`, username: `match-cap-${suffix}` } });
  const bigshot = await prisma.bigshot.create({ data: { name: `Concurrency test ${suffix}`, gameCount: 250 } });
  try {
    const game = await prisma.game.create({
      data: {
        userId: user.id,
        lichessGameId: `match-cap-game-${suffix}`,
        playerColor: "white",
        opponentUsername: "test-opponent",
        moves: ["e4", "e5", "Nf3"],
        result: "win",
        rated: true,
        speed: "rapid",
      },
    });
    await prisma.bigshotPhaseProfile.create({
      data: {
        bigshotId: bigshot.id,
        phase: "opening",
        vector: { materialAggression: 0, kingSafetyDelta: 0, pieceActivityDifferential: 0, pawnStructureBucket: 0, evalVolatility: 0 },
        sampleSize: 250,
      },
    });
    await prisma.notificationPreference.create({
      data: { userId: user.id, vanityMatchOptIn: true, emailAddress: "test@example.invalid" },
    });
    await prisma.gameMoment.createMany({
      data: [0, 1, 2].map((ply) => ({
        userId: user.id,
        gameId: game.id,
        ply,
        phase: "opening",
        moveNumber: ply + 1,
        san: ["e4", "e5", "Nf3"][ply]!,
        fenBeforeMove: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        soundness: "sound",
        matchedBigshotId: bigshot.id,
        matchDistance: 0.2 + ply * 0.1,
        sampleGameId: `sample-${ply}`,
        status: "matched",
      })),
    });

    let releaseFirstSend!: () => void;
    let firstSendStarted!: () => void;
    const firstSendStartedPromise = new Promise<void>((resolve) => { firstSendStarted = resolve; });
    const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    let sendCalls = 0;
    const testSender = async () => {
      sendCalls++;
      if (sendCalls === 1) {
        firstSendStarted();
        await firstSendGate;
      }
      return true;
    };

    const firstRun = deliverPlayerStyleMatches(new Date(), testSender);
    await firstSendStartedPromise;
    const secondRun = await deliverPlayerStyleMatches(new Date(), testSender);
    assert.equal(secondRun.sent, 0, "overlapping invocation must observe both reserved slots");
    assert.equal(sendCalls, 1, "second invocation must not begin another email while first run is in flight");

    releaseFirstSend();
    const firstResult = await firstRun;
    assert.equal(firstResult.sent, 2, "first invocation should fill, but not exceed, the two-email allowance");
    assert.equal(await prisma.emailSendLog.count({ where: { userId: user.id } }), 2);
    assert.equal(sendCalls, 2);
    console.log("Concurrent reranker cap check passed: two invocations sent exactly two emails total.");
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.bigshot.delete({ where: { id: bigshot.id } });
  }
}

main().catch((error) => {
  console.error("Concurrent reranker cap check failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
