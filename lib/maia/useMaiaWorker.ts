import { useEffect, useRef, useCallback } from "react";

type PendingResolve = (result: { topMoveIndex: number; topMoveUci: string; logitsMaia: Float32Array }) => void;
type PendingReject = (err: Error) => void;

export function useMaiaWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, { resolve: PendingResolve; reject: PendingReject }>>(new Map());

  useEffect(() => {
    const worker = new Worker(new URL("../../public/workers/maia.worker.ts", import.meta.url));
    workerRef.current = worker;

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

    return () => worker.terminate();
  }, []);

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


 