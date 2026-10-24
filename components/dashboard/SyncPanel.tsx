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
  const hasAutoSynced = useRef(false);

  useEffect(() => {
    if (autoSyncOnMount && !hasAutoSynced.current) {
      hasAutoSynced.current = true;
      void syncNow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function syncNow(force = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const payload = (await response.json()) as SyncResponse;
      if (!response.ok) throw new Error(payload.error ?? `Sync failed (${response.status})`);
      setSynced(payload.synced ?? 0);
      setTotalGames(payload.totalGames ?? totalGames);
      setLastSyncedAt(payload.lastSyncedAt ?? null);
      setSkipped(payload.skipped ?? false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="game-sync" className="mt-8 max-w-xl space-y-3 rounded border border-neutral-700 p-5">
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
        onClick={() => void syncNow(true)}
        disabled={busy}
        className="rounded border border-white px-3 py-2 text-sm hover:bg-white hover:text-black disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </section>
  );
}
