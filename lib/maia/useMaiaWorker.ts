import { useEffect, useRef, useCallback } from "react";

export interface MaiaInferenceResult {
  topMoveIndex: number;
  topMoveUci: string;
  logitsMaia: Float32Array;
}

export interface MaiaPrototypeMatch {
  playerId: number;
  confidence: number;
}

type PendingReject = (err: Error) => void;
type PendingRequest =
  | {
      type: "infer";
      resolve: (result: MaiaInferenceResult) => void;
      reject: PendingReject;
    }
  | {
      type: "match";
      resolve: (result: MaiaPrototypeMatch | null) => void;
      reject: PendingReject;
    };

export function isMaiaWorkerStopped(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function stoppedError(): Error {
  const error = new Error("Maia inference was cancelled because its worker stopped.");
  error.name = "AbortError";
  return error;
}

export function useMaiaWorker(enabled = true) {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(new URL("../../public/workers/maia.worker.ts", import.meta.url));
    workerRef.current = worker;
    const pendingRequests = pendingRef.current;

    worker.onmessage = (e: MessageEvent) => {
      const { id, type, ok } = e.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (ok) {
        if (pending.type !== type) {
          pending.reject(new Error("Maia worker returned a response for the wrong request."));
        } else if (pending.type === "infer") {
          pending.resolve({
            topMoveIndex: e.data.topMoveIndex,
            topMoveUci: e.data.topMoveUci,
            logitsMaia: e.data.logitsMaia,
          });
        } else {
          pending.resolve(e.data.match);
        }
      } else {
        pending.reject(new Error(e.data.error));
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "Maia worker failed to load or run.");
      for (const request of pendingRequests.values()) request.reject(error);
      pendingRequests.clear();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.onmessageerror = () => {
      const error = new Error("Maia worker returned a message that could not be read.");
      for (const request of pendingRequests.values()) request.reject(error);
      pendingRequests.clear();
      if (workerRef.current === worker) workerRef.current = null;
    };

    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      const pending = [...pendingRequests.values()];
      pendingRequests.clear();
      for (const request of pending) request.reject(stoppedError());
    };
  }, [enabled]);

  const infer = useCallback(
    (
      fen: string,
      selfRating: number | null,
      oppRating: number | null,
      playerId?: number,
    ) => {
      return new Promise<MaiaInferenceResult>((resolve, reject) => {
        const worker = workerRef.current;
        if (!worker) {
          reject(new Error("Worker not initialized"));
          return;
        }
        const id = crypto.randomUUID();
        pendingRef.current.set(id, { type: "infer", resolve, reject });
        try {
          worker.postMessage({ type: "infer", id, fen, selfRating, oppRating, playerId });
        } catch (error) {
          pendingRef.current.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    []
  );

  const matchPrototype = useCallback((
    gameMoveUcis: string[][],
    playerName?: string | null,
  ) => {
    return new Promise<MaiaPrototypeMatch | null>((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error("Worker not initialized"));
        return;
      }
      const id = crypto.randomUUID();
      pendingRef.current.set(id, { type: "match", resolve, reject });
      try {
        worker.postMessage({ type: "match", id, gameMoveUcis, playerName });
      } catch (error) {
        pendingRef.current.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, []);

  return { infer, matchPrototype };
}


 
