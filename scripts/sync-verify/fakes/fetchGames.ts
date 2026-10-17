// In-memory stand-in for lib/lichess/fetchGames.ts, scoped to this
// verification script by the local tsconfig path overrides.
export interface FetchGamesOptions {
  username: string;
  max?: number;
  rated?: boolean;
  perfType?: string;
  since?: number;
  until?: number;
}

export let fetchGamesCallCount = 0;
export const fetchGamesCallLog: FetchGamesOptions[] = [];

type FakeGame = { id: string; createdAt: number; [key: string]: unknown };
let nextBatch: FakeGame[] = [];

export function __setNextBatch(games: FakeGame[]) {
  nextBatch = games;
}

export function __resetSpy() {
  fetchGamesCallCount = 0;
  fetchGamesCallLog.length = 0;
}

export async function fetchGames(opts: FetchGamesOptions): Promise<FakeGame[]> {
  fetchGamesCallCount++;
  fetchGamesCallLog.push(opts);
  return nextBatch
    .filter((game) => (opts.since === undefined || game.createdAt > opts.since) &&
      (opts.until === undefined || game.createdAt <= opts.until))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, opts.max ?? 20);
}
