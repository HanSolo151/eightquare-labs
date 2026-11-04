"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SyncPanelProps {
  initialTotalGames: number;
}

interface SyncResponse {
  synced?: number;
  totalGames?: number;
  lastSyncedAt?: string;
  historyBackfillComplete?: boolean;
  skipped?: boolean;
  error?: string;
}

export function SyncPanel({ initialTotalGames }: SyncPanelProps) {
  const router = useRouter();
  const [synced, setSynced] = useState(0);
  const [totalGames, setTotalGames] = useState(initialTotalGames);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batchNumber, setBatchNumber] = useState(0);
  const [historyBackfillComplete, setHistoryBackfillComplete] = useState(false);
  async function syncNow(force = true) {
    setBusy(true);
    setError(null);
    setSynced(0);
    setBatchNumber(0);
    let syncedThisRun = 0;
    let batchesCompleted = 0;
    let finalPayload: SyncResponse | null = null;
    try {
      // Each request persists at most 100 historical games. Continue in a
      // sequential loop so the page stays interactive and can show progress.
      for (let batch = 1; batch <= 5; batch++) {
        batchesCompleted = batch;
        setBatchNumber(batch);
        const response = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force, skipIncremental: batch > 1 }),
        });
        const payload = (await response.json()) as SyncResponse;
        if (!response.ok) throw new Error(payload.error ?? `Sync failed (${response.status})`);
        finalPayload = payload;
        syncedThisRun += payload.synced ?? 0;
        setSynced(syncedThisRun);
        setTotalGames(payload.totalGames ?? totalGames);
        setLastSyncedAt(payload.lastSyncedAt ?? null);
        setSkipped(payload.skipped ?? false);
        const complete = payload.historyBackfillComplete ?? true;
        setHistoryBackfillComplete(complete);
        if (payload.skipped || complete) break;
      }
      if (syncedThisRun > 0) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (finalPayload && finalPayload.historyBackfillComplete === false && batchesCompleted >= 5) {
        setError("Sync paused after five batches. It will continue from here on your next visit or sync.");
      }
      setBusy(false);
    }
  }

  return (
    <section id="game-sync" className="space-y-2 border-y border-white/10 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-400">
          {busy
            ? `Syncing batch ${batchNumber} of 5 · ${synced} new`
            : skipped
              ? "Your archive was synced recently."
              : historyBackfillComplete && totalGames > 0
                ? `${totalGames.toLocaleString()} games in your archive · up to date`
                : `${totalGames.toLocaleString()} games in your archive`}
        </p>
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={busy}
          className="shrink-0 rounded px-2 py-1 text-xs text-emerald-200 transition hover:bg-emerald-300/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
        >
          {busy ? "Syncing…" : "Sync Lichess"}
        </button>
      </div>
      {busy && <p className="text-[11px] text-neutral-500" role="status">Saving each batch as it arrives; you can keep using the page.</p>}
      {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      {!busy && lastSyncedAt && <p className="text-[10px] text-neutral-600">Last synced {new Date(lastSyncedAt).toLocaleString()}</p>}
    </section>
  );
}
