"use client";

import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import ChessgroundBoard from "./ChessgroundBoard";
import PositionSpar from "./PositionSpar";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import { evalFenMultiPv } from "@/lib/eval/stockfishEngine";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import type { GhostMoment } from "@/lib/ghost/getGhostMoment";

const NEUTRAL_FEATURES: OpponentFeatures = {
  username: "", gamesAnalyzed: 0, mostCommonOpenings: [], queenTradeRate: 0.5,
  aggressionIndex: 0.5, avgRating: null, fetchedAt: 0,
};

interface ReplayLine {
  label: string;
  san: string | null;
  fen: string | null;
  detail: string | null;
}

function lineFromUci(fenBefore: string, uci: string | null): { san: string; fen: string } | null {
  if (!uci || uci.length < 4) return null;
  const chess = new Chess(fenBefore);
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return move ? { san: move.san, fen: chess.fen() } : null;
  } catch {
    return null;
  }
}

function replayLine(fenBefore: string, san: string): string | null {
  const chess = new Chess(fenBefore);
  try { return chess.move(san) ? chess.fen() : null; } catch { return null; }
}

export default function GhostReplay({ moment }: { moment: GhostMoment }) {
  const { infer } = useMaiaWorker(true);
  const [lines, setLines] = useState<ReplayLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSpar, setShowSpar] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const maiaPromise = infer(moment.fenBefore, moment.playerRating, moment.opponentRating).then((inference) =>
        rerankMoves({ fen: moment.fenBefore, logitsMaia: inference.logitsMaia, opponentFeatures: NEUTRAL_FEATURES })
      );
      const [stockfishResult, maiaResult] = await Promise.allSettled([
        evalFenMultiPv(moment.fenBefore, 1),
        maiaPromise,
      ]);
      if (cancelled) return;

      const playedFen = replayLine(moment.fenBefore, moment.playedSan);
      const stockfish = stockfishResult.status === "fulfilled" ? stockfishResult.value[0] : null;
      const sfMove = lineFromUci(moment.fenBefore, stockfish?.uci ?? null);
      const maia = maiaResult.status === "fulfilled" ? maiaResult.value.baseTopMove : null;
      const maiaMove = lineFromUci(moment.fenBefore, maia?.uci ?? null);
      const sfScore = stockfish?.mate !== null && stockfish?.mate !== undefined
        ? `Mate in ${Math.abs(stockfish.mate)} (${stockfish.mate > 0 ? "mover winning" : "mover losing"})`
        : stockfish?.cp !== null && stockfish?.cp !== undefined
          ? `${stockfish.cp > 0 ? "+" : ""}${(stockfish.cp / 100).toFixed(2)} pawns from the side-to-move perspective`
          : null;
      const issues = [
        stockfishResult.status === "rejected" ? "Stockfish unavailable" : null,
        maiaResult.status === "rejected" ? "Maia unavailable" : null,
      ].filter(Boolean).join("; ");
      setLines([
        { label: "What you played", san: moment.playedSan, fen: playedFen, detail: `${Math.round(moment.cpLoss)} cp loss recorded by the saved analysis` },
        { label: "Stockfish top choice", san: sfMove?.san ?? null, fen: sfMove?.fen ?? null, detail: sfScore },
        { label: `Maia choice at ${moment.playerRating ?? "unknown"} rating`, san: maiaMove?.san ?? null, fen: maiaMove?.fen ?? null, detail: maia ? "Base Maia prediction; not opponent-specific" : issues || "No legal Maia choice available" },
      ]);
      if (issues) setError(issues);
    }

    void run().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Ghost replay failed to load.");
    });
    return () => { cancelled = true; };
  }, [moment, infer]);

  return <div>
    {error && <p role="status" className="mb-4 text-sm text-amber-200">{error}. Available lines are shown below.</p>}
    {!lines ? <p className="text-sm text-neutral-400">Loading Stockfish and Maia choices…</p> : <div className="grid gap-4 sm:grid-cols-3">
      {lines.map((line) => <div key={line.label} className="rounded-xl border border-white/10 bg-black/35 p-3">
        <p className="text-xs text-neutral-400">{line.label}</p>
        {line.fen ? <div className="mt-2"><ChessgroundBoard fen={line.fen} orientation={moment.playerColor} /></div> : <p className="mt-2 aspect-square max-w-[220px] content-center text-xs text-neutral-600">Unavailable</p>}
        <p className="mt-2 font-mono text-sm text-white">{line.san ?? "—"}</p>
        {line.detail && <p className="mt-1 text-xs text-neutral-400">{line.detail}</p>}
      </div>)}
    </div>}

    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" onClick={() => setShowSpar((shown) => !shown)} aria-expanded={showSpar} className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-200 hover:bg-amber-400/20">
        {showSpar ? "Close spar" : "Drill this position"}
      </button>
    </div>
    {showSpar && <div className="mt-5 max-w-[420px]"><PositionSpar fen={moment.fenBefore} humanColor={moment.playerColor} maiaRating={moment.opponentRating} humanRating={moment.playerRating} opponentUsername={moment.opponentUsername} effectiveRatingFires={moment.effectiveRatingFires} /></div>}
  </div>;
}
