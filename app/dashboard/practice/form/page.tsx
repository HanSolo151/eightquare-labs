import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/getDashboardData";
import {
  getAmbientPaceAggregate,
  getBlunderHourStats,
  getComebackIndex,
  getMostExpensiveMove,
  getPersonalRecords,
  getSelfCpLossTrend,
} from "@/lib/dashboard/getSignatureSignals";
import EarlyRead from "@/components/dashboard/EarlyRead";
import MostExpensiveMove from "@/components/dashboard/MostExpensiveMove";
import PersonalRecords from "@/components/dashboard/PersonalRecords";
import ComebackIndex from "@/components/dashboard/ComebackIndex";
import BlunderHour from "@/components/dashboard/BlunderHour";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

const PHASES = ["opening", "middlegame", "endgame"] as const;

export default function PracticeFormPage() {
  return <Suspense fallback={<DashboardPageFallback />}><FormPageContent /></Suspense>;
}

async function FormPageContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your form.</p>;

  const [data, cpLossTrend, mostExpensiveMove, personalRecords, comebackIndex, blunderHour, ambientPace] = await Promise.all([
    getDashboardData(userId),
    getSelfCpLossTrend(userId),
    getMostExpensiveMove(userId),
    getPersonalRecords(userId),
    getComebackIndex(userId),
    getBlunderHourStats(userId),
    getAmbientPaceAggregate(userId),
  ]);
  if (!data) return <p className="text-sm text-neutral-400">Your account record is not available yet. Try refreshing after signing in.</p>;

  const profile = data.playerProfile;
  const maxSeconds = Math.max(...PHASES.map((phase) => profile?.avgMoveTimeSecByPhase[phase] ?? 0), 1);

  return <div className="space-y-7 pb-12">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Personal trends</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Form</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">Descriptive trends from your saved games and evaluations—not a rating estimate or a prediction of future results.</p>
    </header>

    <section className="grid gap-6 border-b border-white/10 pb-6 xl:grid-cols-[1.15fr_0.85fr]">
      <section>
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Move quality history</p>
        <h2 className="mt-2 text-lg font-medium">Flagged move CP-loss trend</h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Compares recent flagged moves with the preceding flagged moves. Three moves per period are required; changes under 25 cp are labeled steady.</p>
        {cpLossTrend ? <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={`rounded-full border px-3 py-1 text-xs ${cpLossTrend.trend === "improving" ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-200" : cpLossTrend.trend === "worsening" ? "border-amber-300/25 bg-amber-300/10 text-amber-200" : "border-white/10 text-neutral-300"}`}>{cpLossTrend.trend === "improving" ? "↓ Improving" : cpLossTrend.trend === "worsening" ? "↑ Worsening" : "→ Steady"}</span>
          <p className="text-xs text-neutral-400">Previous {cpLossTrend.previousAvgCp} cp ({cpLossTrend.previousCount} moves) → recent {cpLossTrend.recentAvgCp} cp ({cpLossTrend.recentCount} moves)</p>
        </div> : <p className="mt-4 text-xs text-neutral-500">At least three recent and three preceding flagged player moves are needed to show a trend.</p>}
      </section>

      <section className="xl:border-l xl:border-white/10 xl:pl-6">
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Tempo profile</p>
        <h2 className="mt-2 text-lg font-medium">Time by phase</h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Average time spent per move, where clock data is available.</p>
        <div className="mt-6 space-y-4">
          {PHASES.map((phase) => {
            const seconds = profile?.avgMoveTimeSecByPhase[phase] ?? null;
            return <div key={phase}>
              <div className="mb-2 flex justify-between text-xs">
                <span className="capitalize text-neutral-300">{phase}</span>
                <span className="tabular-nums text-neutral-400">{seconds === null ? "No sample" : `${seconds.toFixed(1)} sec / move`}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-300" style={{ width: `${seconds === null ? 0 : Math.max(4, seconds / maxSeconds * 100)}%` }} /></div>
            </div>;
          })}
        </div>
        <p className="mt-4 text-xs text-neutral-500">Profile coverage: {profile?.gamesAnalyzed ?? 0} games. Timing is descriptive, not a rating of move quality.</p>
      </section>
    </section>

    <div className="grid gap-6 border-b border-white/10 pb-6 xl:grid-cols-2">
      <ComebackIndex data={comebackIndex} />
      <BlunderHour data={blunderHour} />
    </div>
    <PersonalRecords records={personalRecords} />
    <MostExpensiveMove move={mostExpensiveMove} />
    <EarlyRead
      flags={data.recentFlags.map((flag) => ({ gameId: flag.gameId, phase: flag.phase, cpLoss: flag.cpLoss }))}
      evaluatedGames={data.evaluatedGames}
      totalGames={data.totalGames}
    />
    {ambientPace && <section className="border-t border-white/10 pt-5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Evaluation runs · this month (UTC)</p>
      <h2 className="mt-2 text-lg font-medium">Recurring multi-move evaluation losses</h2>
      <p className="mt-1 text-xs leading-5 text-neutral-500">Retrospective signal from evaluated games, grouped by opening and phase. It does not infer tilt or decision-making from the clock.</p>
      <p className="mt-4 text-sm text-neutral-200">Seen in <strong className="font-semibold text-emerald-200">{ambientPace.gameCount} games</strong>, most often in {ambientPace.openingName} during the {ambientPace.phase}.</p>
    </section>}
  </div>;
}
