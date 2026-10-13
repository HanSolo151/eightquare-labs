// Separate worker/wrapper from Maia entirely. Lite single-threaded WASM build,
// no COOP/COEP requirement. Do NOT import anything from lib/maia/* here —
// keeping these fully decoupled is intentional, per the scope boundary.

let enginePromise: Promise<Worker> | null = null;

function getEngine(): Promise<Worker> {
  if (!enginePromise) {
    enginePromise = new Promise((resolve) => {
      const worker = new Worker("/api/stockfish/stockfish-19-lite-single.js");
      const onReady = (e: MessageEvent) => {
        if (e.data === "uciok") {
          worker.removeEventListener("message", onReady);
          resolve(worker);
        }
      };
      worker.addEventListener("message", onReady);
      worker.postMessage("uci");
    });
  }
  return enginePromise;
}

export interface EvalResult {
  cp: number | null;
  mate: number | null;
  depth: number;
}

const SEARCH_DEPTH = 14; // tunable — depth vs latency tradeoff, not validated against anything yet
let evaluationQueue: Promise<void> = Promise.resolve();

export function evalFen(fen: string): Promise<EvalResult> {
  const result = evaluationQueue.then(() => runEvaluation(fen));
  evaluationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function runEvaluation(fen: string): Promise<EvalResult> {
  const worker = await getEngine();
  return new Promise((resolve) => {
    let best: EvalResult = { cp: null, mate: null, depth: 0 };
    const onMessage = (e: MessageEvent) => {
      const line: string = e.data;
      if (line.startsWith("info") && line.includes("score")) {
        const cpMatch = line.match(/score cp (-?\d+)/);
        const mateMatch = line.match(/score mate (-?\d+)/);
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) best.depth = parseInt(depthMatch[1], 10);
        if (cpMatch) { best.cp = parseInt(cpMatch[1], 10); best.mate = null; }
        if (mateMatch) { best.mate = parseInt(mateMatch[1], 10); best.cp = null; }
      }
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