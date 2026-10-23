import { prisma } from "../lib/prisma";
import { processNextVanityEvaluation } from "../lib/matching/vanityEvaluationQueue";

async function main(): Promise<void> {
  const now = new Date();
  const [queued, processing, failed, complete, due] = await Promise.all([
    prisma.vanityEvaluationJob.count({ where: { status: "queued" } }),
    prisma.vanityEvaluationJob.count({ where: { status: "processing" } }),
    prisma.vanityEvaluationJob.count({ where: { status: "failed" } }),
    prisma.vanityEvaluationJob.count({ where: { status: "complete" } }),
    prisma.vanityEvaluationJob.count({ where: { status: "queued", availableAt: { lte: now } } }),
  ]);
  const [profiles, calibrations] = await Promise.all([
    prisma.bigshotPhaseProfile.count(),
    prisma.bigshotVectorCalibration.count(),
  ]);
  console.log(JSON.stringify({ queue: { queued, processing, failed, complete, due }, corpus: { profiles, calibrations } }, null, 2));

  if (due > 0) {
    console.log("Worker execution skipped: due production jobs exist; this validation will not consume real users' queue work.");
    return;
  }
  const result = await processNextVanityEvaluation(now);
  if (result.claimed) throw new Error("Worker claimed a job even though the preflight found no due jobs.");
  console.log("Queue worker idle-claim validation passed: no due job claimed and no production game was evaluated.");
}

main().catch((error) => {
  console.error("Vanity queue validation failed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
