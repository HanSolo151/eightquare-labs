import type { GameEval, EvalPoint } from "@/types";
import { Chess } from "chess.js";
import { evalFen } from "./stockfishEngine";

const ENGINE_VERSION = "sf-lite-v1";
const DB_NAME = "eval-cache";
const STORE = "games";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "gameId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedEval(gameId: string): Promise<GameEval | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(gameId);
    tx.onsuccess = () => {
      const result = tx.result as GameEval | undefined;
      resolve(result && result.engineVersion === ENGINE_VERSION ? result : null);
    };
    tx.onerror = () => resolve(null);
  });
}

async function putCachedEval(evalResult: GameEval): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(evalResult);
}

/** Evaluates every position in a game, ply by ply. Checks cache first. */
export async function evalGame(gameId: string, moves: string[]): Promise<GameEval> {
  const cached = await getCachedEval(gameId);
  if (cached) return cached;

  const chess = new Chess();
  const points: EvalPoint[] = [];
  let evalBefore = await evalFen(chess.fen());

  for (let ply = 0; ply < moves.length; ply++) {
    const move = chess.move(moves[ply]);
    if (!move) {
      throw new Error(`Invalid SAN "${moves[ply]}" at ply ${ply} in game ${gameId}`);
    }
    const fenAfter = chess.fen();
    const evalAfter = await evalFen(fenAfter);

    // Normalize to the mover's POV (Stockfish reports from side-to-move's POV,
    // so "after" needs sign-flipping since it's now the opponent to move).
    points.push({
      ply,
      cpBefore: evalBefore.cp,
      cpAfter: evalAfter.cp !== null ? -evalAfter.cp : null,
      mateBefore: evalBefore.mate,
      mateAfter: evalAfter.mate !== null ? -evalAfter.mate : null,
      depth: Math.min(evalBefore.depth, evalAfter.depth),
    });

    // This position is the next ply's "before" position too. Reuse its raw
    // side-to-move score rather than searching it again.
    evalBefore = evalAfter;
  }

  const result: GameEval = { gameId, points, evaluatedAt: Date.now(), engineVersion: ENGINE_VERSION };
  await putCachedEval(result);
  return result;
}