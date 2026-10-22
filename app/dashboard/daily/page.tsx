import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getDailyPuzzle } from "@/lib/puzzle/getDailyPuzzle";
import DailyPuzzle from "@/components/dashboard/DailyPuzzle";

export const instant = false;

export default async function DailyPage() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your daily puzzle.</p>;
  const snapshot = await getDailyPuzzle(userId);
  return <div className="space-y-6 pb-12">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Daily puzzle</p>
      <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">From your own unresolved blunders</h1>
    </header>
    {!snapshot.trackingAvailable ? <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-4 py-5 text-xs leading-5 text-amber-100/80">Daily Puzzle is temporarily unavailable because the database is missing its practice-tracking tables. Apply the pending Prisma migrations to enable puzzle and resolution tracking.</p> : snapshot.puzzle ? <DailyPuzzle key={`${snapshot.puzzle.gameId}:${snapshot.puzzle.ply}`} puzzle={snapshot.puzzle} /> : <p className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-xs text-neutral-500">No unresolved flagged moves right now — nothing to drill.</p>}
  </div>;
}
