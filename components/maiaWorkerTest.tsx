"use client";

// TEMPORARY debug component for validating Step 7 end-to-end. Mount this
// somewhere reachable (e.g. a throwaway /debug/maia page) and remove once
// confirmed — not meant to ship as part of the product UI.
//
// Validates against Step 1's known-good results (items 17 and 21-22):
// starting position should produce top move index 169 ("g1f3").

import { useEffect, useState } from "react";
import { useMaiaWorker } from "../lib/maia/useMaiaWorker";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EXPECTED_INDEX = 169;
const EXPECTED_UCI = "g1f3";

export default function MaiaWorkerTest() {
  const { infer } = useMaiaWorker();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<{
    topMoveIndex: number;
    topMoveUci?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("running");

    // Elo bucket 5 (1500-1599) for both sides, matching Step 1's validation
    // setup ("elo bucket 5 for both sides").
    infer(STARTING_FEN, 1550, 1550)
      .then((res) => {
        if (cancelled) return;
        setResult(res as any);
        setStatus("done");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [infer]);

  if (status === "idle" || status === "running") {
    return <div>Running Maia-2 worker inference on starting position...</div>;
  }

  if (status === "error") {
    return (
      <div style={{ color: "red" }}>
        <strong>Worker inference failed:</strong> {error}
      </div>
    );
  }

  const indexMatch = result?.topMoveIndex === EXPECTED_INDEX;
  const uciMatch = result?.topMoveUci === EXPECTED_UCI;

  return (
    <div style={{ fontFamily: "monospace", padding: 16 }}>
      <h3>Step 7 end-to-end validation</h3>
      <p>Expected (from Step 1, Python): index {EXPECTED_INDEX}, move {EXPECTED_UCI}</p>
      <p>
        Got: index {result?.topMoveIndex}, move {result?.topMoveUci ?? "(not resolved)"}
      </p>
      <p style={{ color: indexMatch && uciMatch ? "green" : "red", fontWeight: "bold" }}>
        {indexMatch && uciMatch
          ? "PASS — worker output matches Python reference"
          : "FAIL — mismatch, do not trust the pipeline yet"}
      </p>
      {!indexMatch && (
        <p>
          Index mismatch suggests either the board tensor encoding or the
          onnx session itself is producing different results than Step 1's
          Python export — re-check the fp16 conversion and tensor shape
          before debugging further.
        </p>
      )}
    </div>
  );
}