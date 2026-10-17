import { auth } from "@/lib/auth";
import { getSessionUserId, getSessionPlan } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { SyncPanel } from "@/components/dashboard/SyncPanel";

export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  const userId = getSessionUserId(session);
  // Render from stored data immediately; SyncPanel starts the throttled sync
  // after mount so the page doesn't wait for Lichess.
  const totalGames = userId ? await prisma.game.count({ where: { userId } }) : 0;

  return (
    <div className="space-y-8">
      <p className="text-sm text-neutral-400">plan: {getSessionPlan(session)}</p>

      <section className="rounded border border-neutral-800 p-6">
        <h1 className="text-sm text-neutral-400">Your signature</h1>
        <p className="mt-2 text-neutral-500">
          Not wired up yet — this screen will display the saved insights from GET /api/dashboard.
        </p>
      </section>

      <SyncPanel initialTotalGames={totalGames} autoSyncOnMount />
    </div>
  );
}
