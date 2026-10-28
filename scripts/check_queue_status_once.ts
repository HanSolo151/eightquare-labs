import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const { prisma } = await import("@/lib/prisma");
  try {
    const statuses = await prisma.vanityEvaluationJob.groupBy({ by: ["status"], _count: { _all: true } });
    const processing = await prisma.vanityEvaluationJob.findMany({
      where: { status: "processing" },
      select: { id: true, attempts: true, lockedAt: true, lastError: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    console.log(JSON.stringify({ statuses, processing }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
