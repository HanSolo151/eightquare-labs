export default function LiveGameContext({ phase, timeSpentSec, phaseAvgSec, opponentUsername }: {
  phase: string;
  timeSpentSec: number;
  phaseAvgSec: number;
  opponentUsername: string;
}) {
  return <section className="mt-4 border-t border-white/10 pt-3" aria-label="Live game context">
    <p className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Live game context</p>
    <p className="mt-2 text-xs leading-5 text-neutral-300">
      You played this in <strong>{timeSpentSec.toFixed(1)}s</strong>
      {timeSpentSec < 30 ? <span className="ml-1 text-amber-200">· under 30 seconds</span> : null}.
      {" "}Your {phase} average was <strong>{phaseAvgSec.toFixed(1)}s</strong> against {opponentUsername}.
    </p>
  </section>;
}
