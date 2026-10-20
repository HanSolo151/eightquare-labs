import type { AmbientPaceSignal as Signal } from "@/lib/pace/getAmbientPaceSignal";

export default function AmbientPaceSignal({ signal }: { signal: Signal }) {
  const moveRange = signal.startMove === signal.endMove
    ? `move ${signal.startMove}`
    : `moves ${signal.startMove}–${signal.endMove}`;

  return (
    <p className="text-xs text-neutral-500">
      For the record: a cascade decline occurred on {moveRange}; this pattern has appeared in {signal.priorOccurrences} earlier games in this opening and phase.
    </p>
  );
}
