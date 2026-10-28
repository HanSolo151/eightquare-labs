export default function DashboardPageFallback() {
  return (
    <div aria-busy="true" className="space-y-6 pb-12" role="status" aria-label="Loading dashboard page">
      <div className="animate-pulse border-b border-white/10 pb-6">
        <div className="h-3 w-28 rounded bg-neutral-800" />
        <div className="mt-4 h-8 w-64 max-w-full rounded bg-neutral-800" />
        <div className="mt-3 h-4 w-full max-w-xl rounded bg-neutral-900" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-36 animate-pulse rounded-xl border border-white/10 bg-white/[0.025]" />
        <div className="h-36 animate-pulse rounded-xl border border-white/10 bg-white/[0.025]" />
      </div>
      <span className="sr-only">Loading page content…</span>
    </div>
  );
}
