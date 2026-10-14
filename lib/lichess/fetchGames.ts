export interface FetchGamesOptions {
  username: string;
  max?: number;
  rated?: boolean;
  perfType?: "rapid" | "blitz" | "bullet" | "classical";
  since?: number; // ms timestamp
  until?: number; // ms timestamp
}

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
}
export interface FetchGamesOptions {
  username: string;
  max?: number;
  rated?: boolean;
  perfType?: "rapid" | "blitz" | "bullet" | "classical";
  since?: number; // ms timestamp
  until?: number; // ms timestamp
}

/**
 * Streams a user's games from the Lichess public API as NDJSON
 * and returns them as an array of raw game objects.
 * Docs: https://lichess.org/api#tag/Games/operation/apiGamesUser
 */
export async function fetchGames(opts: FetchGamesOptions): Promise<any[]> {
  const { username, max = 20, rated = true, perfType = "rapid", since, until } = opts;

  const params = new URLSearchParams({
    max: String(max),
    rated: String(rated),
    perfType,
    clocks: "true",
    opening: "true",
    moves: "true",
  });
  if (since) params.set("since", String(since));
  if (until) params.set("until", String(until));

  const url = `https://lichess.org/api/games/user/${encodeURIComponent(
    username
  )}?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: "application/x-ndjson" },
  });

  if (!res.ok) {
    throw new LichessFetchError(res.status, res.statusText);
  }
  if (!res.body) {
    throw new Error("Lichess response had no body (streaming not supported)");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const games: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep last partial line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      games.push(JSON.parse(trimmed));
    }
  }

  // flush any trailing line without a newline
  const trimmed = buffer.trim();
  if (trimmed) games.push(JSON.parse(trimmed));

  return games;
}