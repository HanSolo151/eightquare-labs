import type { WeaknessProfile } from "@/types";

const DB_NAME = "weakness-profile-cache";
const STORE = "profiles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "username" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getProfile(username: string): Promise<WeaknessProfile | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(username);
    tx.onsuccess = () => resolve((tx.result as WeaknessProfile) ?? null);
    tx.onerror = () => resolve(null);
  });
}

export async function saveProfile(profile: WeaknessProfile): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(profile);
}

export function emptyProfile(username: string): WeaknessProfile {
  return {
    username,
    patterns: [],
    evaluatedGameIds: [],
    gamesEvaluated: 0,
    gamesFetched: 0,
    confidence: "low",
    builtAt: Date.now(),
  };
}