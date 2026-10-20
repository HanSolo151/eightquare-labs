import type { PatternsData } from "@/lib/patterns/getPatternsData";

const PHASES = ["opening", "middlegame", "endgame"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;
const PHASE_NAMES = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

export default function PatternsHeatmap({ data }: { data: PatternsData }) {
  const max = Math.max(1, ...PHASES.flatMap((phase) => SEVERITIES.map((severity) => data.heatmap[phase][severity])));
  const totalFlags = PHASES.reduce((sum, phase) => sum + SEVERITIES.reduce((inner, severity) => inner + data.heatmap[phase][severity], 0), 0);

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-medium">Flagged moves by phase</h2>
        <p className="mt-1 text-sm text-neutral-400">Counts of persisted flags. Brighter cells contain more flags; these are counts, not rates.</p>
      </div>
      {totalFlags === 0 ? (
        <p className="rounded-xl bg-[#17161A] p-5 text-sm text-neutral-400">No saved flags yet. Sync and evaluate games to see where flagged moves occur.</p>
      ) : (
        <div className="grid max-w-2xl grid-cols-[minmax(100px,1fr)_repeat(3,minmax(52px,0.7fr))] gap-2 text-center">
          <div />
          {SEVERITIES.map((severity) => <div key={severity} className="pb-1 text-xs capitalize text-neutral-400">{severity}</div>)}
          {PHASES.map((phase) => (
            <div key={phase} className="contents">
              <div className="flex items-center text-left text-sm text-neutral-300">{PHASE_NAMES[phase]}</div>
              {SEVERITIES.map((severity) => {
                const count = data.heatmap[phase][severity];
                const opacity = count ? 0.12 + (count / max) * 0.78 : 0.035;
                return <div key={`${phase}-${severity}`} className="flex aspect-square max-h-20 items-center justify-center rounded-lg font-mono text-sm tabular-nums text-white" style={{ backgroundColor: `rgba(226, 92, 69, ${opacity})` }} aria-label={`${PHASE_NAMES[phase]}, ${severity}: ${count} flags`}>{count}</div>;
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
