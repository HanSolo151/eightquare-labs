export interface FetchGamesOptions {
  username: string;
  max?: number;
  rated?: boolean;
  perfType?: "rapid" | "blitz" | "bullet" | "classical";
  since?: number; // ms timestamp
  until?: number; // ms timestamp
}

export type LichessRawGame = Record<string, unknown>;

/**
 * Streams a user's games from the Lichess public API as NDJSON
 * and returns them as an array of raw game objects.
 * Docs: https://lichess.org/api#tag/Games/operation/apiGamesUser
 */
export class LichessFetchError extends Error {
  constructor(
    public readonly status: number,
    statusText: string
  ) {
    super(`Lichess fetch failed: ${status} ${statusText}`);
    this.name = "LichessFetchError";
  }

  /** True when Lichess returned 404 for a missing or renamed account. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

const GAME_CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_REQUEST_GAP_MS = 1000;
const RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_429_RETRIES = 1;
const gameCache = new Map<string, { expiresAt: number; games: LichessRawGame[] }>();
const inFlight = new Map<string, Promise<LichessRawGame[]>>();
let requestQueue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;
let rateLimitedUntil = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) return RATE_LIMIT_WAIT_MS;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(RATE_LIMIT_WAIT_MS, seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(RATE_LIMIT_WAIT_MS, date - Date.now()) : RATE_LIMIT_WAIT_MS;
}
async function fetchGamesRequest(opts: FetchGamesOptions): Promise<LichessRawGame[]> {
  const { username, max = 20, rated, perfType, since, until } = opts;

  const params = new URLSearchParams({
    max: String(max),
    clocks: "true",
    opening: "true",
    moves: "true",
  });
  if (rated !== undefined) params.set("rated", String(rated));
  if (perfType) params.set("perfType", perfType);
  if (since !== undefined) params.set("since", String(since));
  if (until !== undefined) params.set("until", String(until));

  const url = `https://lichess.org/api/games/user/${encodeURIComponent(
    username
  )}?${params.toString()}`;

  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const pauseUntil = Math.max(nextRequestAt, rateLimitedUntil);
    if (pauseUntil > Date.now()) await wait(pauseUntil - Date.now());
    nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;
    res = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
    if (res.status !== 429) break;

    const backoffMs = retryAfterMs(res);
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + backoffMs);
    await res.body?.cancel().catch(() => undefined);
    if (attempt === MAX_429_RETRIES) throw new LichessFetchError(res.status, res.statusText);
  }

  if (!res || !res.ok) {
    throw new LichessFetchError(res?.status ?? 0, res?.statusText ?? "No response");
  }
  if (!res.body) {
    throw new Error("Lichess response had no body (streaming not supported)");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const games: LichessRawGame[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep last partial line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      games.push(asLichessRawGame(JSON.parse(trimmed)));
    }
  }

  // flush any trailing line without a newline
  const trimmed = buffer.trim();
  if (trimmed) games.push(asLichessRawGame(JSON.parse(trimmed)));

  return games;
}

/**
 * Fetches recent games with same-query coalescing, a short in-memory cache,
 * and a process-local serial queue. Lichess asks API clients to send one
 * request at a time and wait a full minute after HTTP 429 responses.
 */
export function fetchGames(opts: FetchGamesOptions): Promise<LichessRawGame[]> {
  const key = JSON.stringify({
    username: opts.username.trim().toLowerCase(),
    max: opts.max ?? 20,
    // Omitted filters produce a different upstream URL than explicit
    // `rated=true, perfType=rapid`; keep those cache entries distinct.
    rated: opts.rated ?? null,
    perfType: opts.perfType ?? null,
    since: opts.since ?? null,
    until: opts.until ?? null,
  });
  const cached = gameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.games);
  if (cached) gameCache.delete(key);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = requestQueue.then(() => fetchGamesRequest(opts));
  requestQueue = request.then(() => undefined, () => undefined);
  inFlight.set(key, request);
  void request.then((games) => {
    gameCache.set(key, { expiresAt: Date.now() + GAME_CACHE_TTL_MS, games });
    if (gameCache.size > 50) {
      const oldestKey = gameCache.keys().next().value;
      if (oldestKey) gameCache.delete(oldestKey);
    }
  }).finally(() => {
    inFlight.delete(key);
  }).catch(() => undefined);
  return request;
}

function asLichessRawGame(value: unknown): LichessRawGame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Lichess returned a game record that was not a JSON object");
  }
  return value as LichessRawGame;
}
