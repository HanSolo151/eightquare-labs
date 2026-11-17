export default function LockedCard({ current, total, label }: { current: number; total: number; label: string }) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.min(safeTotal, Math.floor(current))) : 0;
  const barWidth = 10;
  const filled = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * barWidth) : 0;
  const progress = `${"▓".repeat(filled)}${"░".repeat(barWidth - filled)}`;

  return <section className="flex flex-wrap items-center justify-between gap-3 border-y border-white/10 py-3 text-xs">
    <span className="text-neutral-500">{label}</span>
    <span className="flex items-center gap-3">
      <span aria-hidden="true" className="font-mono tracking-widest text-neutral-500">{progress}</span>
      <span className="font-mono tabular-nums text-neutral-300">{safeCurrent}/{safeTotal}</span>
      <span className="sr-only" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={safeTotal} aria-valuenow={safeCurrent} />
    </span>
  </section>;
}
