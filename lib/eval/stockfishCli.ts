import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

type EvalScore = { cp: number | null; mate: number | null; bestMoveUci: string | null; depth: number };

export interface ServerEvalResult {
  cp: number | null;
  mate: number | null;
  depth: number;
  bestMoveUci: string | null;
}

export class StockfishCli {
  private pending: { resolve: (value: EvalScore) => void; reject: (error: Error) => void; latest: EvalScore } | null = null;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lineWaiters = new Set<{ predicate: (line: string) => boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    createInterface({ input: child.stdout }).on("line", this.onLine);
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code) => {
      if (code !== 0) this.rejectAll(new Error(`Stockfish exited with code ${code}`));
    });
  }

  static async create(): Promise<StockfishCli> {
    const enginePath = path.join(process.cwd(), "node_modules", "stockfish", "bin", "stockfish-19-lite-single.js");
    const child = spawn(process.execPath, [enginePath], { stdio: ["pipe", "pipe", "pipe"] });
    const engine = new StockfishCli(child);
    try {
      const uciReady = engine.waitFor((line) => line === "uciok");
      child.stdin.write("uci\n");
      await uciReady;
      child.stdin.write("setoption name Threads value 1\nisready\n");
      await engine.waitFor((line) => line === "readyok");
      return engine;
    } catch (error) {
      engine.close();
      throw error;
    }
  }

  async evaluate(fen: string, depth: number): Promise<ServerEvalResult> {
    if (this.pending) throw new Error("Stockfish CLI evaluation requests must be serialized");
    const response = new Promise<EvalScore>((resolve, reject) => {
      this.pending = { resolve, reject, latest: { cp: null, mate: null, bestMoveUci: null, depth: 0 } };
    });
    this.process.stdin.write(`position fen ${fen}\ngo depth ${depth}\n`);
    return response;
  }

  close(): void {
    if (!this.process.killed) {
      this.process.stdin.write("quit\n");
      setTimeout(() => this.process.kill(), 1_000).unref();
    }
  }

  private waitFor(predicate: (line: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: () => { clearTimeout(waiter.timer); this.lineWaiters.delete(waiter); resolve(); },
        reject,
        timer: setTimeout(() => {
          this.lineWaiters.delete(waiter);
          reject(new Error("Stockfish UCI handshake timed out"));
        }, 60_000),
      };
      this.lineWaiters.add(waiter);
    });
  }

  private rejectAll(error: Error): void {
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
    for (const waiter of this.lineWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.lineWaiters.clear();
  }

  private onLine = (line: string): void => {
    for (const waiter of [...this.lineWaiters]) if (waiter.predicate(line)) waiter.resolve();
    const pending = this.pending;
    if (!pending) return;
    if (line.startsWith("info")) {
      const depth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? pending.latest.depth);
      const cpMatch = line.match(/\bscore cp (-?\d+)/);
      const mateMatch = line.match(/\bscore mate (-?\d+)/);
      if (depth >= pending.latest.depth) {
        pending.latest = {
          cp: cpMatch ? Number(cpMatch[1]) : mateMatch ? null : pending.latest.cp,
          mate: mateMatch ? Number(mateMatch[1]) : cpMatch ? null : pending.latest.mate,
          bestMoveUci: pending.latest.bestMoveUci,
          depth,
        };
      }
      return;
    }
    if (line.startsWith("bestmove")) {
      const bestMoveUci = line.split(/\s+/)[1] ?? null;
      pending.resolve({ ...pending.latest, bestMoveUci });
      this.pending = null;
    }
  };
}
