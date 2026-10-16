import type { OpponentTimePressureProfile } from "@/types";

const DB_NAME = "time-pressure-profile-cache";
const STORE = "profiles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "username" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getTimePressureProfile(username: string): Promise<OpponentTimePressureProfile | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(username);
    request.onsuccess = () => resolve((request.result as OpponentTimePressureProfile) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function saveTimePressureProfile(profile: OpponentTimePressureProfile): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(profile);
}
