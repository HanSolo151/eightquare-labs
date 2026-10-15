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
const engineSlots: EngineSlot[] = Array.from({ length: ENGINE_POOL_SIZE }, () => ({
  workerPromise: null,
  queue: Promise.resolve(),
  pending: 0,
}));

function getWorker(slot: EngineSlot): Promise<Worker> {
  if (!slot.workerPromise) {
    slot.workerPromise = new Promise((resolve, reject) => {
      const worker = new Worker("/api/stockfish/stockfish-19-lite-single.js");
      const onReady = (event: MessageEvent) => {
        if (event.data === "uciok") {
          worker.removeEventListener("message", onReady);
          worker.removeEventListener("error", onError);
          resolve(worker);
        }
      };
      const onError = (event: ErrorEvent) => {
        worker.removeEventListener("message", onReady);
        worker.removeEventListener("error", onError);
        worker.terminate();
        slot.workerPromise = null;
        reject(new Error(event.message || "Stockfish worker failed to start"));
      };
      worker.addEventListener("message", onReady);
      worker.addEventListener("error", onError);
      worker.postMessage("uci");
    });
  }
  return slot.workerPromise;
}

export interface EvalResult {
  cp: number | null;
  mate: number | null;
  depth: number;
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
  };
}

const SEARCH_DEPTH = 14; // tunable — depth vs latency tradeoff, not validated against anything yet

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
  return new Promise((resolve) => {
    let best: EvalResult = { cp: null, mate: null, depth: 0 };
    const onMessage = (e: MessageEvent) => {
      const line: string = e.data;
      best = parseStockfishInfoLine(line, best);
      if (line.startsWith("bestmove")) {
        worker.removeEventListener("message", onMessage);
        resolve(best);
      }
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${SEARCH_DEPTH}`);
  });
}