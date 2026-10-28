"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessgroundBoard from "@/components/board/ChessgroundBoard";
import { evalFenMultiPv, type MultiPvLine } from "@/lib/eval/stockfishEngine";
import type { DailyPuzzle as DailyPuzzleData } from "@/lib/puzzle/getDailyPuzzle";

type Status = "idle" | "checking" | "saving" | "correct" | "incorrect" | "error";
const DAILY_PUZZLE_NEAR_EQUAL_CP = 25;

export default function DailyPuzzle({ puzzle }: { puzzle: DailyPuzzleData }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [boardFen, setBoardFen] = useState(puzzle.fenBefore);
  const [solved, setSolved] = useState(false);
  const [busySkipping, setBusySkipping] = useState(false);
  const [acceptNearEqual, setAcceptNearEqual] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [preparedLines, setPreparedLines] = useState<MultiPvLine[] | null>(null);
  const [prepareAttempt, setPrepareAttempt] = useState(0);

  // Start the depth-16 MultiPV search as soon as this puzzle mounts, so a move
  // joins the prepared result instead of starting a search after the click.
  useEffect(() => {
    let active = true;
    void evalFenMultiPv(puzzle.fenBefore, 5).then((lines) => {
      if (active) {
        setPreparedLines(lines);
        setPrepared(true);
      }
    }).catch((error: unknown) => {
      console.error("Daily puzzle engine preparation failed:", error);
      if (active) setPrepareFailed(true);
    });
    return () => { active = false; };
  }, [puzzle.fenBefore, prepareAttempt]);
  const dests = useMemo(() => {
    const chess = new Chess(boardFen);
    const map = new Map<Key, Key[]>();
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      map.set(from, [...(map.get(from) ?? []), move.to as Key]);
    }
    return map;
  }, [boardFen]);

  async function onUserMove(from: Key, to: Key) {
    if (!prepared || status === "checking" || status === "saving" || busySkipping || solved) return;
    const chess = new Chess(puzzle.fenBefore);
    let move;
    try { move = chess.move({ from, to, promotion: "q" }); } catch { return; }
    if (!move) return;
    const playedUci = move.from + move.to + (move.promotion ?? "");
    setBoardFen(chess.fen());
    setStatus("checking");
    try {
      const lines = preparedLines ?? await evalFenMultiPv(puzzle.fenBefore, 5);
      const best = lines.find((line) => line.multipv === 1) ?? lines[0];
      const isTopMove = best?.uci === playedUci;
      const isNearEqual = acceptNearEqual && best?.cp !== null && best?.cp !== undefined && lines.some((line) =>
        line.uci === playedUci && line.cp !== null && line.cp !== undefined &&
        best.cp! - line.cp <= DAILY_PUZZLE_NEAR_EQUAL_CP
      );
      if (!isTopMove && !isNearEqual) {
        setBoardFen(puzzle.fenBefore);
        setStatus("incorrect");
        return;
      }
      setStatus("saving");
      const response = await fetch("/api/puzzle/solve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: puzzle.gameId, ply: puzzle.ply }),
      });
      if (!response.ok) throw new Error("The correct move could not be saved. Please retry.");
      setSolved(true);
      setStatus("correct");
    } catch (error) {
      setBoardFen(puzzle.fenBefore);
      setStatus("error");
      console.error("Daily puzzle check/save failed:", error);
    }
  }

  async function skip() {
    setBusySkipping(true);
    try {
      const response = await fetch("/api/puzzle/skip", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: puzzle.gameId, ply: puzzle.ply }),
      });
      if (!response.ok) throw new Error("Could not save this skip. Try again.");
      router.refresh();
    } catch (error) {
      setStatus("error");
      console.error("Daily puzzle skip failed:", error);
    } finally {
      setBusySkipping(false);
    }
  }

  const interactive = prepared && !solved && status !== "checking" && status !== "saving" && !busySkipping;
  return <div className="rounded-xl border border-white/10 bg-black/35 p-4">
    <p className="text-xs text-neutral-400">Your {puzzle.severity}-severity missed move from a game against {puzzle.opponentUsername}.</p>
    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
      <input type="checkbox" checked={acceptNearEqual} onChange={(event) => setAcceptNearEqual(event.target.checked)} disabled={solved || status === "checking" || status === "saving"} />
      Accept a top-five move within 0.25 pawns of Stockfish’s best
    </label>
    <div className="mx-auto mt-3 max-w-[320px]">
      <ChessgroundBoard fen={boardFen} orientation={puzzle.playerColor} interactive={interactive} turnColor={puzzle.playerColor} dests={dests} onUserMove={(from, to) => void onUserMove(from, to)} />
    </div>
    {!prepared && <p className="mt-3 min-h-5 text-center text-xs text-neutral-400" role="status">
      {prepareFailed ? "Stockfish could not prepare this puzzle." : "Preparing Stockfish lines…"}
    </p>}
    {prepareFailed && <div className="mt-2 text-center">
      <button type="button" onClick={() => { setPrepareFailed(false); setPrepareAttempt((attempt) => attempt + 1); }} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10">Retry engine</button>
    </div>}
    <p className="mt-3 min-h-5 text-center text-xs" aria-live="polite">
      {status === "checking" && "Checking your move…"}
      {status === "saving" && "Correct. Saving progress…"}
      {status === "correct" && "Solved and saved."}
      {status === "incorrect" && (acceptNearEqual ? "That move is outside Stockfish’s top-five 0.25-pawn margin. Try again." : "Not the engine’s top choice. Try again.")}
      {status === "error" && "Could not complete that action. You can try again."}
    </p>
    <div className="mt-3 flex justify-center gap-3">
      <button type="button" onClick={() => void skip()} disabled={busySkipping || status === "checking" || status === "saving" || solved} className="rounded-lg border border-white/10 px-4 py-2 text-xs text-neutral-300 hover:bg-white/10 disabled:opacity-40">{busySkipping ? "Skipping…" : "Skip"}</button>
    </div>
  </div>;
}
