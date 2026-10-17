"use client";

import { useState } from "react";

interface SyncPanelProps {
  initialSynced: number;
  initialTotalGames: number;
  initialLastSyncedAt: string | null;
  initialSkipped: boolean;
  initialError: string | null;
}

interface SyncResponse {
  synced?: number;
  totalGames?: number;
  lastSyncedAt?: string;
  skipped?: boolean;
  error?: string;
}

export function SyncPanel({
  initialSynced,
  initialTotalGames,
  initialLastSyncedAt,
  initialSkipped,
  initialError,
}: SyncPanelProps) {
  const [synced, setSynced] = useState(initialSynced);
  const [totalGames, setTotalGames] = useState(initialTotalGames);
  const [lastSyncedAt, setLastSyncedAt] = useState(initialLastSyncedAt);
  const [skipped, setSkipped] = useState(initialSkipped);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sync", { method: "POST" });
      const payload = (await response.json()) as SyncResponse;
      if (!response.ok) throw new Error(payload.error ?? `Sync failed (${response.status})`);
      setSynced(payload.synced ?? 0);
      setTotalGames(payload.totalGames ?? totalGames);
      setLastSyncedAt(payload.lastSyncedAt ?? null);
      setSkipped(payload.skipped ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 max-w-xl space-y-3 rounded border border-neutral-700 p-5">
      <h2 className="text-sm">Lichess game sync</h2>
      <p className="text-sm text-neutral-300">
        {synced} new games synced · {totalGames} games stored
      </p>
      {skipped && <p className="text-xs text-neutral-400">Sync skipped; the account was synced recently.</p>}
      <p className="text-xs text-neutral-400">
        Last sync: {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "never"}
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="button"
        onClick={syncNow}
        disabled={busy}
        className="rounded border border-white px-3 py-2 text-sm hover:bg-white hover:text-black disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </section>
  );
}
