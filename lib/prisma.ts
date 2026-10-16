import { PrismaClient } from "@prisma/client";

// Standard Next.js dev-mode singleton: without this, hot reload spawns a
// new PrismaClient (and new connection pool) on every file change.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
