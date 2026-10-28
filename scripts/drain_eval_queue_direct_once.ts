import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
  const [{ prisma }, { processNextVanityEvaluation }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/matching/vanityEvaluationQueue"),
  ]);
  try {
    const due = await prisma.vanityEvaluationJob.count({ where: { status: "queued", availableAt: { lte: new Date() } } });
    console.log(`Due jobs at start: ${due}`);
    for (let index = 0; index < due; index++) {
      const started = Date.now();
      const result = await processNextVanityEvaluation();
      if (!result.claimed) break;
      const statuses = await prisma.vanityEvaluationJob.groupBy({ by: ["status"], _count: { _all: true } });
      console.log(JSON.stringify({ job: index + 1, completed: result.completed, elapsedSeconds: ((Date.now() - started) / 1000).toFixed(1), statuses }));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
