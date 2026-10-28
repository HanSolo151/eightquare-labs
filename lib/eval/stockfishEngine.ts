// Separate worker/wrapper from Maia entirely. Lite single-threaded WASM build,
// no COOP/COEP requirement. Do NOT import anything from lib/maia/* here —
// keeping these fully decoupled is intentional, per the scope boundary.

interface EngineSlot {
  workerPromise: Promise<Worker> | null;
  queue: Promise<void>;
  pending: number;
}

// The lite engine is memory-light, but two isolated WASM instances provide
// useful parallelism without spawning one engine per game/search request.
const ENGINE_POOL_SIZE = 2;
const ENGINE_START_TIMEOUT_MS = 15_000;
const ENGINE_SEARCH_TIMEOUT_MS = 120_000;
const engineSlots: EngineSlot[] = Array.from({ length: ENGINE_POOL_SIZE }, () => ({
  workerPromise: null,
  queue: Promise.resolve(),
  pending: 0,
}));

function getWorker(slot: EngineSlot): Promise<Worker> {
  if (!slot.workerPromise) {
    const workerPromise = new Promise<Worker>((resolve, reject) => {
      const worker = new Worker("/api/stockfish/stockfish-19-lite-single.js");
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        slot.workerPromise = null;
        reject(new Error("Stockfish worker startup timed out"));
      }, ENGINE_START_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timeout);
        worker.removeEventListener("message", onReady);
        worker.removeEventListener("error", onError);
      };
      const onReady = (event: MessageEvent) => {
        if (settled || event.data !== "uciok") return;
        settled = true;
        cleanup();
        resolve(worker);
      };
      const onError = (event: ErrorEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        worker.terminate();
        slot.workerPromise = null;
        reject(new Error(event.message || "Stockfish worker failed to start"));
      };
      worker.addEventListener("message", onReady);
      worker.addEventListener("error", onError);
      worker.postMessage("uci");
    });
    slot.workerPromise = workerPromise;
    void workerPromise.catch(() => {
      if (slot.workerPromise === workerPromise) slot.workerPromise = null;
    });
  }
  return slot.workerPromise;
}

function discardWorker(slot: EngineSlot, worker: Worker): void {
  slot.workerPromise = null;
  worker.terminate();
}

export interface EvalResult {
  cp: number | null;
  mate: number | null;
  depth: number;
  bestMoveUci: string | null;
}

/** Parse one UCI info line. `score cp` is already expressed in centipawns. */
export function parseStockfishInfoLine(line: string, current: EvalResult): EvalResult {
  if (!line.startsWith("info")) return current;
  const depthMatch = line.match(/\bdepth (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  return {
    cp: cpMatch ? Number.parseInt(cpMatch[1], 10) : mateMatch ? null : current.cp,
    mate: mateMatch ? Number.parseInt(mateMatch[1], 10) : cpMatch ? null : current.mate,
    depth: depthMatch ? Number.parseInt(depthMatch[1], 10) : current.depth,
    bestMoveUci: current.bestMoveUci,
  };
}

// Phase 2e: bumped from 14 to 16 (within the doc's suggested 16-18 range,
// chose the conservative end — still a tunable, not validated against
// anything yet). IMPORTANT: this requires ENGINE_VERSION in evalCache.ts to
// be bumped alongside it, or every cached game silently keeps serving
// depth-14 evals under a cache that thinks it's fresh — see that file.
const SEARCH_DEPTH = 16;

// Multi-PV is reserved for on-demand pivot-move attribution. Its cost scales
// with the number of requested lines, so it stays out of the background sweep.
export interface MultiPvLine {
  multipv: number;
  cp: number | null;
  mate: number | null;
  depth: number;
  uci: string | null;
}

function parseMultiPvInfoLine(line: string, lines: Map<number, MultiPvLine>): void {
  if (!line.startsWith("info")) return;
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  if (!multipvMatch) return;
  const multipv = Number.parseInt(multipvMatch[1], 10);
  const existing = lines.get(multipv);
  const depthMatch = line.match(/\bdepth (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const pvMatch = line.match(/\bpv (\S+)/);
  lines.set(multipv, {
    multipv,
    cp: cpMatch ? Number.parseInt(cpMatch[1], 10) : mateMatch ? null : existing?.cp ?? null,
    mate: mateMatch ? Number.parseInt(mateMatch[1], 10) : cpMatch ? null : existing?.mate ?? null,
    depth: depthMatch ? Number.parseInt(depthMatch[1], 10) : existing?.depth ?? 0,
    uci: pvMatch ? pvMatch[1] : existing?.uci ?? null,
  });
}

const MULTIPV_SEARCH_DEPTH = SEARCH_DEPTH;
const MULTIPV_CACHE_LIMIT = 24;
const multiPvCache = new Map<string, Promise<MultiPvLine[]>>();

export function evalFenMultiPv(fen: string, numLines = 3): Promise<MultiPvLine[]> {
  const cacheKey = `${fen}\n${numLines}\n${MULTIPV_SEARCH_DEPTH}`;
  const cached = multiPvCache.get(cacheKey);
  if (cached) {
    // Refresh insertion order for a small LRU and don't expose cached objects
    // to callers that might mutate them.
    multiPvCache.delete(cacheKey);
    multiPvCache.set(cacheKey, cached);
    return cached.then((lines) => lines.map((line) => ({ ...line })));
  }

  const slot = engineSlots.reduce((leastBusy, candidate) =>
    candidate.pending < leastBusy.pending ? candidate : leastBusy
  );
  slot.pending++;
  const result = slot.queue.then(() => runMultiPvEvaluation(slot, fen, numLines));
  slot.queue = result.then(() => undefined, () => undefined);
  void result.finally(() => { slot.pending--; }).catch(() => undefined);
  multiPvCache.set(cacheKey, result);
  while (multiPvCache.size > MULTIPV_CACHE_LIMIT) {
    const oldestKey = multiPvCache.keys().next().value;
    if (oldestKey === undefined) break;
    multiPvCache.delete(oldestKey);
  }
  void result.catch(() => {
    if (multiPvCache.get(cacheKey) === result) multiPvCache.delete(cacheKey);
  });
  return result.then((lines) => lines.map((line) => ({ ...line })));
}

async function runMultiPvEvaluation(slot: EngineSlot, fen: string, numLines: number): Promise<MultiPvLine[]> {
  const worker = await getWorker(slot);
  return new Promise((resolve, reject) => {
    const lines = new Map<number, MultiPvLine>();
    let sawMultiPvLine = false;
    const timeout = window.setTimeout(() => fail(new Error("Stockfish MultiPV search timed out")), ENGINE_SEARCH_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      discardWorker(slot, worker);
      reject(error);
    };
    const onError = (event: ErrorEvent) => fail(new Error(event.message || "Stockfish worker failed during MultiPV search"));
    const onMessage = (e: MessageEvent) => {
      const line: string = e.data;
      if (line.startsWith("info") && /\bmultipv \d+/.test(line)) sawMultiPvLine = true;
      parseMultiPvInfoLine(line, lines);
      if (line.startsWith("bestmove")) {
        cleanup();
        worker.postMessage("setoption name MultiPV value 1");
        if (!sawMultiPvLine) {
          reject(new Error(
            "Stockfish worker never reported a multipv info line — this build may not support MultiPV"
          ));
          return;
        }
        resolve(Array.from(lines.values()).sort((a, b) => a.multipv - b.multipv).slice(0, numLines));
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(`setoption name MultiPV value ${numLines}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${MULTIPV_SEARCH_DEPTH}`);
  });
}

export function evalFen(fen: string): Promise<EvalResult> {
  const slot = engineSlots.reduce((leastBusy, candidate) =>
    candidate.pending < leastBusy.pending ? candidate : leastBusy
  );
  slot.pending++;
  const result = slot.queue.then(() => runEvaluation(slot, fen));
  slot.queue = result.then(() => undefined, () => undefined);
  void result.finally(() => { slot.pending--; }).catch(() => undefined);
  return result;
}

async function runEvaluation(slot: EngineSlot, fen: string): Promise<EvalResult> {
  const worker = await getWorker(slot);
  return new Promise((resolve, reject) => {
    let best: EvalResult = { cp: null, mate: null, depth: 0, bestMoveUci: null };
    const timeout = window.setTimeout(() => fail(new Error("Stockfish search timed out")), ENGINE_SEARCH_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      discardWorker(slot, worker);
      reject(error);
    };
    const onError = (event: ErrorEvent) => fail(new Error(event.message || "Stockfish worker failed during search"));
    const onMessage = (e: MessageEvent) => {
      const line: string = e.data;
      if (line.startsWith("bestmove")) {
        const bestMoveMatch = line.match(/^bestmove (\S+)/);
        best = { ...best, bestMoveUci: bestMoveMatch ? bestMoveMatch[1] : null };
        cleanup();
        resolve(best);
        return;
      }
      best = parseStockfishInfoLine(line, best);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${SEARCH_DEPTH}`);
  });
}
