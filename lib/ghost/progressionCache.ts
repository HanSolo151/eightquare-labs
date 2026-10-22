export interface ProgressionMove {
  uci: string;
  san: string;
  fen: string;
  cp: number | null;
  mate: number | null;
}

export interface ProgressionLine {
  id: "engine" | "maia";
  label: string;
  description: string;
  pgn: string;
  moves: ProgressionMove[];
  decisive: boolean;
  stopReason: string | null;
}

export interface CachedProgression {
  key: string;
  version: 2;
  gameId: string;
  ply: number;
  startingFen: string;
  userRating: number | null;
  lines: [ProgressionLine, ProgressionLine];
  generatedAt: number;
}

const DB_NAME = "ghost-progression-cache";
const STORE_NAME = "continuations";
const CACHE_VERSION = 2;

function progressionKey(gameId: string, ply: number) {
  return `${gameId}:${ply}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, CACHE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open continuation cache."));
  });
}

export async function getCachedProgression(gameId: string, ply: number): Promise<CachedProgression | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(progressionKey(gameId, ply));
    request.onsuccess = () => {
      db.close();
      const value = request.result as CachedProgression | undefined;
      resolve(value?.version === CACHE_VERSION ? value : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("Could not read continuation cache."));
    };
  });
}

export async function putCachedProgression(value: Omit<CachedProgression, "key" | "version" | "generatedAt">): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      ...value,
      key: progressionKey(value.gameId, value.ply),
      version: CACHE_VERSION,
      generatedAt: Date.now(),
    } satisfies CachedProgression);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save continuation cache."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Continuation cache write was aborted."));
  }).finally(() => db.close());
}
