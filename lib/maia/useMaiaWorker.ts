import { useEffect, useRef, useCallback } from "react";

export interface MaiaInferenceResult {
  topMoveIndex: number;
  topMoveUci: string;
  logitsMaia: Float32Array;
}

type PendingResolve = (result: MaiaInferenceResult) => void;
type PendingReject = (err: Error) => void;

export function useMaiaWorker(enabled = true) {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, { resolve: PendingResolve; reject: PendingReject }>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(new URL("../../public/workers/maia.worker.ts", import.meta.url));
    workerRef.current = worker;
    const pendingRequests = pendingRef.current;

    worker.onmessage = (e: MessageEvent) => {
      const { id, ok } = e.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (ok) {
        pending.resolve({ topMoveIndex: e.data.topMoveIndex, topMoveUci: e.data.topMoveUci, logitsMaia: e.data.logitsMaia });
      } else {
        pending.reject(new Error(e.data.error));
      }
    };

    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      const pending = [...pendingRequests.values()];
      pendingRequests.clear();
      for (const request of pending) request.reject(new Error("Maia worker stopped."));
    };
  }, [enabled]);

  const infer = useCallback(
    (fen: string, selfRating: number | null, oppRating: number | null) => {
      return new Promise<{ topMoveIndex: number; topMoveUci: string; logitsMaia: Float32Array }>((resolve, reject) => { 
        const worker = workerRef.current;
        if (!worker) {
          reject(new Error("Worker not initialized"));
          return;
        }
        const id = crypto.randomUUID();
        pendingRef.current.set(id, { resolve, reject });
        worker.postMessage({ id, fen, selfRating, oppRating });
      });
    },
    []
  );

  return { infer };
}


 
