"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SyncPanelProps {
  initialTotalGames: number;
  autoSyncOnMount?: boolean;
}

interface SyncResponse {
  synced?: number;
  totalGames?: number;
  lastSyncedAt?: string;
  historyBackfillComplete?: boolean;
  skipped?: boolean;
  error?: string;
}

export function SyncPanel({ initialTotalGames, autoSyncOnMount }: SyncPanelProps) {
  const router = useRouter();
  const [synced, setSynced] = useState(0);
  const [totalGames, setTotalGames] = useState(initialTotalGames);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batchNumber, setBatchNumber] = useState(0);
  const [historyBackfillComplete, setHistoryBackfillComplete] = useState(false);
  const hasAutoSynced = useRef(false);

  useEffect(() => {
    if (autoSyncOnMount && !hasAutoSynced.current) {
      hasAutoSynced.current = true;
      // A page visit may refresh stale data, but it should not bypass the
      // server's passive-sync throttle. The button remains an explicit force sync.
      void syncNow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <section id="game-sync" className="mt-8 max-w-xl space-y-3 rounded border border-neutral-700 p-5">
      <h2 className="text-sm">Lichess game sync</h2>
      <p className="text-sm text-neutral-300">
        {busy ? `Syncing batch ${batchNumber} of 5 · ${synced} new games so far` : `${synced} new games synced · ${totalGames} games stored`}
      </p>
      {busy && <p className="text-xs text-neutral-400" role="status">Saving each batch as it arrives; you can keep using the page.</p>}
      {!busy && historyBackfillComplete && totalGames > 0 && <p className="text-xs text-neutral-500">Recent game history is up to date.</p>}
      {skipped && <p className="text-xs text-neutral-400">Sync skipped; the account was synced recently.</p>}
      <p className="text-xs text-neutral-400">
        Last sync: {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "never"}
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={busy}
        className="rounded border border-white px-3 py-2 text-sm hover:bg-white hover:text-black disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </section>
  );
}
