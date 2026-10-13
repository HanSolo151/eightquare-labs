"use client";

// TEMPORARY debug component for validating Step 7 end-to-end. Mount this
// somewhere reachable (e.g. a throwaway /debug/maia page) and remove once
// confirmed — not meant to ship as part of the product UI.
//
// Validates against Step 1's known-good results (items 17 and 21-22):
// starting position should produce top move index 169 ("g1f3").

import { useEffect, useState } from "react";
import { useMaiaWorker } from "../lib/maia/useMaiaWorker";
import { mirrorUci } from "../lib/maia/boardToTensor";

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const STARTING_FEN_BLACK = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
const ASYMMETRIC_FEN_WHITE = "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ASYMMETRIC_FEN_BLACK = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const EXPECTED_INDEX = 169;
const EXPECTED_UCI = "g1f3";

export default function MaiaWorkerTest() {
  const { infer } = useMaiaWorker();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<{
    white: { topMoveIndex: number; topMoveUci: string };
    black: { topMoveIndex: number; topMoveUci: string };
    asymmetricWhite: { topMoveIndex: number; topMoveUci: string };
    asymmetricBlack: { topMoveIndex: number; topMoveUci: string };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("running");

    // Elo bucket 5 (1500-1599) for both sides, matching Step 1's validation
    // setup ("elo bucket 5 for both sides").
    void (async () => {
      try {
        const white = await infer(STARTING_FEN, 1550, 1550);
        const black = await infer(STARTING_FEN_BLACK, 1550, 1550);
        const asymmetricWhite = await infer(ASYMMETRIC_FEN_WHITE, 1550, 1550);
        const asymmetricBlack = await infer(ASYMMETRIC_FEN_BLACK, 1550, 1550);
        if (cancelled) return;
        setResult({ white, black, asymmetricWhite, asymmetricBlack });
        setStatus("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();

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

  const indexMatch = result?.white.topMoveIndex === EXPECTED_INDEX;
  const uciMatch = result?.white.topMoveUci === EXPECTED_UCI;
  const mirrorMatch =
    result !== null && result.black.topMoveUci === mirrorUci(result.white.topMoveUci);
  const asymmetricMirrorMatch =
    result !== null &&
    result.asymmetricBlack.topMoveUci === mirrorUci(result.asymmetricWhite.topMoveUci);

  return (
    <div style={{ fontFamily: "monospace", padding: 16 }}>
      <h3>Step 7 end-to-end validation</h3>
      <p>Expected (from Step 1, Python): index {EXPECTED_INDEX}, move {EXPECTED_UCI}</p>
      <p>White to move: index {result?.white.topMoveIndex}, move {result?.white.topMoveUci}</p>
      <p>Black to move: index {result?.black.topMoveIndex}, move {result?.black.topMoveUci}</p>
      <p>Asymmetric mirror pair: {result?.asymmetricWhite.topMoveUci} / {result?.asymmetricBlack.topMoveUci}</p>
      <p style={{ color: indexMatch && uciMatch && mirrorMatch && asymmetricMirrorMatch ? "green" : "red", fontWeight: "bold" }}>
        {indexMatch && uciMatch && mirrorMatch && asymmetricMirrorMatch
          ? "PASS — reference move and both Black-move mirrors match"
          : "FAIL — reference move or Black-move mirror mismatch"}
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