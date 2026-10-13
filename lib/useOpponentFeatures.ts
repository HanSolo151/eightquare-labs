import { useCallback, useRef, useState } from "react";
import type { OpponentFeatures } from "./lichess/opponentFeatures";
import {
  loadCachedOpponentFeatures,
  saveCachedOpponentFeatures,
} from "./opponentCache";

interface UseOpponentFeaturesResult {
  features: OpponentFeatures | null;
  loading: boolean;
  error: string | null;
  load: (username: string) => Promise<void>;
}

/**
 * Lazy, on-demand opponent-feature loader. Does NOT fetch on mount — call
 * `load(username)` when a flagged move's opponent is actually expanded in
 * the UI, consistent with Step 8's "when a flagged move is selected"
 * trigger from the original build map.
 *
 * Cache-first: checks localStorage (24h TTL) before hitting the API route.
 */
export function useOpponentFeatures(): UseOpponentFeaturesResult {
  const [features, setFeatures] = useState<OpponentFeatures | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (username: string) => {
    const requestId = ++requestIdRef.current;
    setError(null);

    const cached = loadCachedOpponentFeatures(username);
    if (cached) {
      setFeatures(cached);
      setLoading(false);
      return;
    }

    setFeatures(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/opponent?username=${encodeURIComponent(username)}`
      );
      if (!res.ok) {
        throw new Error(`request failed: ${res.status}`);
      }
      const data: OpponentFeatures = await res.json();
      if (requestId !== requestIdRef.current) return;
      setFeatures(data);
      saveCachedOpponentFeatures(username, data);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  return { features, loading, error, load };
}