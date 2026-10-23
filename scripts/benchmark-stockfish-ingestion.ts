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
  const engine = await StockfishCli.create();
  try {
    const start = performance.now();
    for (const fen of fens) await engine.evaluate(fen, MATCHING_CONFIG.INGEST_EVAL_DEPTH);
    const seconds = (performance.now() - start) / 1000;
    const positions = 8_443_589;
    console.log(JSON.stringify({
      samplePositions: fens.length,
      seconds: Number(seconds.toFixed(2)),
      positionsPerSecond: Number((fens.length / seconds).toFixed(2)),
      approximateCorpusPositions: positions,
      approximateSerialHours: Number((positions / (fens.length / seconds) / 3600).toFixed(1)),
      note: "Estimate only; the corpus includes varied positions and real ingest overhead.",
    }, null, 2));
  } finally {
    engine.close();
  }
}

void main().catch((error) => {
  console.error("Stockfish ingestion benchmark failed:", error);
  process.exitCode = 1;
});
