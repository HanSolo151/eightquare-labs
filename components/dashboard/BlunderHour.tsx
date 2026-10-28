import type { BlunderHourStats } from "@/lib/dashboard/getSignatureSignals";

function formatUtcHour(hour: number): string {
  return `${hour.toString().padStart(2, "0")}:00 UTC`;
}

export default function BlunderHour({ data }: { data: BlunderHourStats }) {
  if (!data.worstHour || !data.bestHour || data.worstHour.hour === data.bestHour.hour) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-black/35 p-5 sm:p-6">
      <p className="text-[10px] uppercase tracking-[0.2em] text-amber-300/80">Blunder hour</p>
      <h2 className="mt-2 text-lg font-medium">Your flagged-move rate is highest around {formatUtcHour(data.worstHour.hour)}</h2>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        {data.worstHour.flagsPerGame.toFixed(1)} flagged moves per game in that hour, vs. {data.bestHour.flagsPerGame.toFixed(1)} around {formatUtcHour(data.bestHour.hour)} — both measured in UTC. Each hour shown has at least five games.
      </p>
    </section>
  );
}
