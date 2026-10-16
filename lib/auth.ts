import NextAuth from "next-auth";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

// Full config — Node runtime only (API routes, server components).
// Extends the edge-safe authConfig with the DB-touching callbacks that
// middleware is NOT allowed to import.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  trustHost : true,
  callbacks: {
    async signIn({ user, account }) {
      console.log("[signIn debug] user:", user, "account:", account);
      if (!user.id) return false;

      await prisma.user.upsert({
        where: { lichessId: user.id },
        update: {
          username: user.name ?? user.id,
          accessToken: account?.access_token ?? null,
          refreshToken: account?.refresh_token ?? null,
          tokenExpiresAt: account?.expires_at
            ? new Date(account.expires_at * 1000)
            : null,
        },
        create: {
          lichessId: user.id,
          username: user.name ?? user.id,
          accessToken: account?.access_token ?? null,
          refreshToken: account?.refresh_token ?? null,
          tokenExpiresAt: account?.expires_at
            ? new Date(account.expires_at * 1000)
            : null,
        },
      });

      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        const dbUser = await prisma.user.findUnique({
          where: { lichessId: user.id },
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
