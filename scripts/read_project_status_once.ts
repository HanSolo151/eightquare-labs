import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
  const { prisma } = await import("@/lib/prisma");
  try {
    const users = await prisma.user.findMany({ select: { id: true, historyBackfillComplete: true, lastSyncedAt: true } });
    const [bigshots, phaseProfiles, calibrations, jobStatuses] = await Promise.all([
      prisma.bigshot.count(),
      prisma.bigshotPhaseProfile.count(),
      prisma.bigshotVectorCalibration.count(),
      prisma.vanityEvaluationJob.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const accountStats = await Promise.all(users.map(async (user) => {
      const [games, evaluated, wins, evaluatedWins, flags] = await Promise.all([
        prisma.game.count({ where: { userId: user.id } }),
        prisma.game.count({ where: { userId: user.id, eval: { isNot: null } } }),
        prisma.game.count({ where: { userId: user.id, result: "win" } }),
        prisma.game.count({ where: { userId: user.id, result: "win", eval: { isNot: null } } }),
        prisma.flaggedMove.count({ where: { game: { userId: user.id } } }),
      ]);
      return { games, evaluated, wins, evaluatedWins, flags, historyBackfillComplete: user.historyBackfillComplete, lastSyncedAt: user.lastSyncedAt };
    }));
    console.log(JSON.stringify({ accounts: users.length, accountStats, bigshots, phaseProfiles, calibrations, jobStatuses }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
