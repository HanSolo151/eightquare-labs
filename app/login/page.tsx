"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-black text-white">
      <h1 className="text-xl font-mono">eightsquare</h1>
      <button
        onClick={() => signIn("lichess", { callbackUrl: "/dashboard" })}
        className="rounded border border-white px-4 py-2 font-mono text-sm hover:bg-white hover:text-black"
      >
        Sign in with Lichess
      </button>
    </main>
  );
}
