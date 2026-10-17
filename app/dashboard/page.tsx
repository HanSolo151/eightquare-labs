import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getSessionUserId, getSessionPlan } from "@/lib/auth/session";
import { runSync } from "@/lib/sync/runSync";
import { SyncPanel } from "@/components/dashboard/SyncPanel";

export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const userId = getSessionUserId(session);
  // Passive sync on load — throttled inside runSync. The SyncPanel button
  // calls POST /api/sync with force instead.
  const result = userId
    ? await runSync(userId)
    : ({ ok: false, error: "no session user id" } as const);

  return (
    <main className="min-h-screen bg-black p-8 font-mono text-white">
      <p>logged in as {session.user.name}</p>
      <p className="text-sm text-neutral-400">plan: {getSessionPlan(session)}</p>

      <SyncPanel
        initialSynced={result.ok ? result.synced : 0}
        initialTotalGames={result.ok ? result.totalGames : 0}
        initialLastSyncedAt={result.ok ? result.lastSyncedAt.toISOString() : null}
        initialSkipped={result.ok && result.skipped}
        initialError={result.ok ? null : result.error}
      />
    </main>
  );
}
