import type { GameEval, EvalPoint } from "@/types";
import { evalFen, type EvalResult } from "./stockfishEngine";
import { evaluateMoveSequenceWith } from "./moveSequence";

// Phase 2e: SEARCH_DEPTH in stockfishEngine.ts bumped 14 -> 16, so this must
// change too to invalidate every depth-14 cached eval (same cache-busting
// pattern as Phase 0's bump to -v2).
const ENGINE_VERSION = "stockfish-19-lite-single-depth16-v2";
const DB_NAME = "eval-cache";
const STORE = "games";
const PARTIAL_STORE = "partials";

interface PartialGameEval {
  gameId: string;
  engineVersion: string;
  expectedPlyCount: number;
  points: EvalPoint[];
  evalBefore: EvalResult;
}

export interface EvalQualityReport {
  gameId: string;
  expectedPlyCount: number;
  actualPointCount: number;
  missingPlies: number[];
  duplicatePlies: number[];
  invalidPlies: number[];
  extraPlies: number[];
  invalidScorePlies: number[];
  invalidDepthPlies: number[];
  mateOnlyPlies: number[];
  cpComparablePlies: number[];
  get structurallyComplete(): boolean;
}

/** Reports coverage and score quality; cp values remain in centipawns. */
export function inspectGameEval(gameEval: GameEval, expectedPlyCount: number): EvalQualityReport {
  const occurrences = new Map<number, number>();
  const missingPlies: number[] = [];
  const duplicatePlies: number[] = [];
  const invalidPlies: number[] = [];
  const extraPlies: number[] = [];
  const invalidScorePlies: number[] = [];
  const invalidDepthPlies: number[] = [];
  const mateOnlyPlies: number[] = [];
  const cpComparablePlies: number[] = [];

  const points = Array.isArray(gameEval.points) ? gameEval.points : [];
  for (const point of points) {
    if (!point || typeof point !== "object") {
      invalidPlies.push(-1);
      continue;
    }
    if (!Number.isInteger(point.ply) || point.ply < 0) {
      invalidPlies.push(point.ply);
      continue;
    }
    occurrences.set(point.ply, (occurrences.get(point.ply) ?? 0) + 1);
    if (point.ply >= expectedPlyCount) extraPlies.push(point.ply);

    const cpValues = [point.cpBefore, point.cpAfter];
    const mateValues = [point.mateBefore, point.mateAfter];
    if (
      !Number.isFinite(point.depth) || point.depth < 0 ||
      (point.depth === 0 && !mateValues.some((value) => value !== null))
    ) invalidDepthPlies.push(point.ply);
    const invalidNumber = cpValues.some((value) => value !== null && !Number.isFinite(value)) ||
      mateValues.some((value) => value !== null && !Number.isFinite(value));
    const contradictoryScore = cpValues.some((value, index) => value !== null && mateValues[index] !== null);
    const missingSideScore = cpValues.some((value, index) => value === null && mateValues[index] === null);

    if (invalidNumber || contradictoryScore || missingSideScore) invalidScorePlies.push(point.ply);
    if (!invalidNumber && !contradictoryScore && cpValues.every((value) => value !== null && Number.isFinite(value))) {
      cpComparablePlies.push(point.ply);
    } else if (
      !invalidNumber && !contradictoryScore &&
      cpValues.some((value, index) => value === null && mateValues[index] !== null)
    ) {
      // A valid mate score is usable for mate-aware work, but not for the
      // current centipawn-delta flag rule.
      mateOnlyPlies.push(point.ply);
    }
  }

  for (let ply = 0; ply < expectedPlyCount; ply++) {
    const count = occurrences.get(ply) ?? 0;
    if (count === 0) missingPlies.push(ply);
    if (count > 1) duplicatePlies.push(ply);
  }

  const structurallyComplete = missingPlies.length === 0 && duplicatePlies.length === 0 &&
    invalidPlies.length === 0 && extraPlies.length === 0 && points.length === expectedPlyCount;

  return {
    gameId: gameEval.gameId,
    expectedPlyCount,
    actualPointCount: points.length,
    missingPlies,
    duplicatePlies,
    invalidPlies,
    extraPlies,
    invalidScorePlies,
    invalidDepthPlies,
    mateOnlyPlies,
    cpComparablePlies,
    structurallyComplete,
  };
}

/** Convert two raw UCI scores into the mover's POV; score values are centipawns. */
export function normalizeEvalPoint(ply: number, before: EvalResult, after: EvalResult): EvalPoint {
  return {
    ply,
    cpBefore: before.cp,
    cpAfter: after.cp !== null ? -after.cp : null,
    mateBefore: before.mate,
    mateAfter: after.mate !== null ? -after.mate : null,
    depth: Math.min(before.depth, after.depth),
    bestMoveUci: before.bestMoveUci,
  };
}

/** Evaluate the initial position and each successive move position exactly once. */
export function evaluateMoveSequence(
  moves: string[],
  evaluatePosition: (fen: string) => Promise<EvalResult> = evalFen,
  onPlyComplete?: (points: EvalPoint[], evalBefore: EvalResult) => Promise<void>,
  checkpoint?: Pick<PartialGameEval, "points" | "evalBefore">
): Promise<EvalPoint[]> {
  return evaluateMoveSequenceWith(moves, evaluatePosition, onPlyComplete, checkpoint);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "gameId" });
      if (!db.objectStoreNames.contains(PARTIAL_STORE)) db.createObjectStore(PARTIAL_STORE, { keyPath: "gameId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedEval(gameId: string, expectedPlyCount?: number): Promise<GameEval | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(gameId);
    tx.onsuccess = () => {
      const result = tx.result as GameEval | undefined;
      if (!result || result.engineVersion !== ENGINE_VERSION) {
        resolve(null);
        return;
      }
      if (result.gameId !== gameId) {
        console.warn("Discarding cached evaluation stored under a different game ID", { gameId, cachedGameId: result.gameId });
        resolve(null);
        return;
      }
      if (expectedPlyCount !== undefined) {
        const quality = inspectGameEval(result, expectedPlyCount);
        if (!quality.structurallyComplete) {
          console.warn("Discarding structurally incomplete cached game evaluation", quality);
          resolve(null);
          return;
        }
      }
      resolve(result);
    };
    tx.onerror = () => resolve(null);
  });
}

async function putCachedEval(evalResult: GameEval): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(evalResult);
}

async function getPartialEval(gameId: string, expectedPlyCount: number): Promise<PartialGameEval | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(PARTIAL_STORE, "readonly").objectStore(PARTIAL_STORE).get(gameId);
    tx.onsuccess = () => {
      const partial = tx.result as PartialGameEval | undefined;
      const valid = partial?.gameId === gameId && partial.engineVersion === ENGINE_VERSION &&
        partial.expectedPlyCount === expectedPlyCount && Array.isArray(partial.points) &&
        partial.points.length <= expectedPlyCount &&
        partial.points.every((point, index) => point?.ply === index) &&
        Number.isFinite(partial.evalBefore?.depth) &&
        (partial.evalBefore.cp === null || Number.isFinite(partial.evalBefore.cp)) &&
        (partial.evalBefore.mate === null || Number.isFinite(partial.evalBefore.mate));
      resolve(valid ? partial : null);
    };
    tx.onerror = () => resolve(null);
  });
}

async function putPartialEval(partial: PartialGameEval): Promise<void> {
  const db = await openDb();
  db.transaction(PARTIAL_STORE, "readwrite").objectStore(PARTIAL_STORE).put(partial);
}

async function deletePartialEval(gameId: string): Promise<void> {
  const db = await openDb();
  db.transaction(PARTIAL_STORE, "readwrite").objectStore(PARTIAL_STORE).delete(gameId);
}

/** Evaluates every position in a game, ply by ply. Checks cache first. */
export async function evalGame(gameId: string, moves: string[]): Promise<GameEval> {
  const cached = await getCachedEval(gameId, moves.length);
  if (cached) return cached;

  const partial = await getPartialEval(gameId, moves.length);
  let points: EvalPoint[];
  try {
    points = await evaluateMoveSequence(moves, evalFen, async (savedPoints, evalBefore) => {
      await putPartialEval({
        gameId,
        engineVersion: ENGINE_VERSION,
        expectedPlyCount: moves.length,
        points: savedPoints,
        evalBefore,
      });
    }, partial ?? undefined);
  } catch (error) {
    throw new Error(
      `Could not evaluate every ply for game ${gameId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result: GameEval = { gameId, points, evaluatedAt: Date.now(), engineVersion: ENGINE_VERSION };
  const quality = inspectGameEval(result, moves.length);
  if (!quality.structurallyComplete || quality.invalidScorePlies.length > 0 || quality.invalidDepthPlies.length > 0) {
    console.warn("Stockfish evaluation contains missing or malformed per-ply data", quality);
  }
  await putCachedEval(result);
  await deletePartialEval(gameId);
  return result;
}
