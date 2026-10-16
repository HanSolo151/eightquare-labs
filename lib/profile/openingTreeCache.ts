import type { OpeningTree } from "@/types";

const DB_NAME = "opening-tree-cache";
const STORE = "trees";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "username" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getOpeningTree(username: string): Promise<OpeningTree | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(username);
    request.onsuccess = () => resolve((request.result as OpeningTree) ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function saveOpeningTree(tree: OpeningTree): Promise<void> {
  const db = await openDb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(tree);
}
