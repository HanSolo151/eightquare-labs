import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { MATCHING_CONFIG } from "../config/matching";
import { StockfishCli } from "./lib/stockfishCli";

async function main(): Promise<void> {
  const engine = await StockfishCli.create();
  try {
    const result = await engine.evaluate(new Chess().fen(), MATCHING_CONFIG.INGEST_EVAL_DEPTH);
    assert.equal(result.depth, MATCHING_CONFIG.INGEST_EVAL_DEPTH);
    assert.ok(result.bestMoveUci);
    console.log("Offline Stockfish UCI check passed.");
  } finally {
    engine.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
