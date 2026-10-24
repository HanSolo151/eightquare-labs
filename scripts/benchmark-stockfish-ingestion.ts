import { StockfishCli } from "./lib/stockfishCli";
import { MATCHING_CONFIG } from "../config/matching";

const fens = [
  "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5",
  "r2q1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP3PPP/RNBQ1RK1 w - - 0 9",
  "2r2rk1/1bqnbppp/pp2pn2/2pp4/3P4/1PN1PN2/PB2BPPP/2RQ1RK1 w - - 0 12",
  "r3r1k1/pp2qppp/2n1bn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQR1K1 w - - 1 14",
  "8/5pk1/6p1/3p4/3P4/5PK1/8/8 w - - 0 35",
  "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 b - - 3 9",
  "2r2rk1/1bqnbppp/pp2pn2/2pp4/3P4/1PN1PN2/PB2BPPP/2RQ1RK1 b - - 0 12",
  "r3r1k1/pp2qppp/2n1bn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQR1K1 b - - 1 14",
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const validationMode = args.includes("--validation");
  const targetArgument = args.find((arg) => arg.startsWith("--target-positions="));
  if (args.some((arg) => arg !== "--validation" && arg !== targetArgument)) {
    throw new Error("Supported options are --validation and --target-positions=<positive integer>.");
  }
  const targetPositions = targetArgument ? Number(targetArgument.slice("--target-positions=".length)) : null;
  if (targetPositions !== null && (!Number.isSafeInteger(targetPositions) || targetPositions <= 0)) {
    throw new Error("--target-positions must be a positive integer.");
  }
  const depth = validationMode
    ? MATCHING_CONFIG.INGEST_EVAL_DEPTH_VALIDATION
    : MATCHING_CONFIG.INGEST_EVAL_DEPTH;
  const repetitions = 10;
  const engine = await StockfishCli.create();
  try {
    const start = performance.now();
    for (let repeat = 0; repeat < repetitions; repeat++) {
      for (const fen of fens) await engine.evaluate(fen, depth);
    }
    const seconds = (performance.now() - start) / 1000;
    const samplePositions = fens.length * repetitions;
    console.log(JSON.stringify({
      evaluationDepth: depth,
      validationMode,
      samplePositions,
      seconds: Number(seconds.toFixed(2)),
      positionsPerSecond: Number((samplePositions / seconds).toFixed(2)),
      targetPositions,
      approximateSerialHours: targetPositions === null
        ? null
        : Number((targetPositions / (samplePositions / seconds) / 3600).toFixed(2)),
      note: "Estimate only; corpus positions vary and parsing/vectorization add overhead.",
    }, null, 2));
  } finally {
    engine.close();
  }
}

void main().catch((error) => {
  console.error("Stockfish ingestion benchmark failed:", error);
  process.exitCode = 1;
});
