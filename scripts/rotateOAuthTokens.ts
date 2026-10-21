import { loadEnvConfig } from "@next/env";
import { decryptOAuthToken, encryptOAuthToken } from "@/lib/auth/tokenEncryption";

loadEnvConfig(process.cwd());

async function main() {
  if (!process.env.AUTH_SECRET || !process.env.AUTH_SECRET_PREVIOUS) {
    throw new Error("Set AUTH_SECRET to the new key and AUTH_SECRET_PREVIOUS to the old key before running this script.");
  }
  if (process.env.AUTH_SECRET === process.env.AUTH_SECRET_PREVIOUS) {
    throw new Error("AUTH_SECRET and AUTH_SECRET_PREVIOUS must be different during token re-encryption.");
  }

  const { prisma } = await import("@/lib/prisma");
  let cursor: string | undefined;
  let rotated = 0;
  try {
    while (true) {
      const users = await prisma.user.findMany({
        take: 100,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: { id: true, accessToken: true, refreshToken: true },
      });
      if (users.length === 0) break;

      await prisma.$transaction(users.map((user) => prisma.user.update({
        where: { id: user.id },
        data: {
          accessToken: encryptOAuthToken(decryptOAuthToken(user.accessToken)),
          refreshToken: encryptOAuthToken(decryptOAuthToken(user.refreshToken)),
        },
      })));
      rotated += users.length;
      cursor = users[users.length - 1].id;
    }
    console.info(`Re-encrypted OAuth tokens for ${rotated} accounts.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error("OAuth token re-encryption failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
