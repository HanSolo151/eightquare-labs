import NextAuth from "next-auth";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";
import { encryptOAuthToken } from "@/lib/auth/tokenEncryption";

// Full config — Node runtime only (API routes, server components).
// Extends the edge-safe authConfig with the DB-touching callbacks that
// middleware is NOT allowed to import.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  trustHost : true,
  callbacks: {
    async signIn({ user, account }) {
      // providerAccountId is Lichess's stable account id. Without a database
      // adapter, Auth.js can generate a fresh user.id on each sign-in.
      if (!account?.providerAccountId) return false;

      await prisma.user.upsert({
        where: { lichessId: account.providerAccountId },
        update: {
          username: user.name ?? account.providerAccountId,
          accessToken: encryptOAuthToken(account?.access_token),
          refreshToken: encryptOAuthToken(account?.refresh_token),
          tokenExpiresAt: account?.expires_at
            ? new Date(account.expires_at * 1000)
            : null,
        },
        create: {
          lichessId: account.providerAccountId,
          username: user.name ?? account.providerAccountId,
          accessToken: encryptOAuthToken(account?.access_token),
          refreshToken: encryptOAuthToken(account?.refresh_token),
          tokenExpiresAt: account?.expires_at
            ? new Date(account.expires_at * 1000)
            : null,
        },
      });

      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.providerAccountId) {
        token.providerAccountId = account.providerAccountId;
      }
      if (user?.id && token.providerAccountId) {
        const dbUser = await prisma.user.findUnique({
          where: { lichessId: token.providerAccountId as string },
          select: { id: true, username: true, plan: true },
        });
        if (dbUser) {
          token.userId = dbUser.id;
          token.username = dbUser.username;
          token.plan = dbUser.plan;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as typeof session.user & { id?: string; plan?: string }).id =
          token.userId as string;
        (session.user as typeof session.user & { plan?: string }).plan =
          token.plan as string;
      }
      return session;
    },
  },
});
