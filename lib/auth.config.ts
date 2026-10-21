import NextAuth from "next-auth"; 

import type { NextAuthConfig } from "next-auth";
import type { OAuthConfig } from "next-auth/providers";

// Edge-safe half of the auth config: no Prisma, no Node-only imports.
// This is what middleware is allowed to use. The full config (with DB
// calls in callbacks) lives in auth.ts and runs only in Node runtime
// (API routes, server components) — never in middleware.
interface LichessProfile {
  id: string;
  username: string;
}

export function LichessProvider(): OAuthConfig<LichessProfile> {
  return {
    id: "lichess",
    name: "Lichess",
    type: "oauth",
    clientId: process.env.LICHESS_CLIENT_ID,
    client: {
      token_endpoint_auth_method: "none",
    },
    checks: ["pkce", "state"],
    authorization: {
      url: "https://lichess.org/oauth",
      params: { scope: "" },
    },
    token: "https://lichess.org/api/token",
    userinfo: "https://lichess.org/api/account",
    profile(profile: LichessProfile) {
      return {
        id: profile.id,
        name: profile.username,
      };
    },
  };
}

const authSecrets = process.env.AUTH_SECRET
  ? [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret))
  : [];

export const authConfig: NextAuthConfig = {
  providers: [LichessProvider()],
  pages: { signIn: "/login" },
  // Auth.js uses the first secret for new tokens and tries all configured
  // secrets when reading existing sessions during a planned rotation.
  ...(authSecrets.length ? { secret: authSecrets } : {}),
  trustHost: true,
};

// Edge-safe instance — session reads only, no DB-touching callbacks.
// This is the one middleware.ts imports.
export const { auth } = NextAuth(authConfig);
