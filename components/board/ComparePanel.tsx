"use client";

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessgroundBoard from "@/components/board/ChessgroundBoard";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import { evalFen, evalFenMultiPv } from "@/lib/eval/stockfishEngine";

interface CompareLine {
  label: string;
  san: string | null;
  fen: string | null;
  cpForPlayer: number | null;
  from: Key | null;
  to: Key | null;
  kind: "played" | "engine" | "maia";
}

function playerEval(result: { cp: number | null; mate: number | null }, fen: string, playerColor: "white" | "black") {
  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  const sign = turn === playerColor ? 1 : -1;
  if (result.cp !== null) return result.cp * sign;
  if (result.mate !== null) return result.mate > 0 ? 1000 * sign : -1000 * sign;
  return null;
}

function moveFromUci(fen: string, uci: string | null) {
  if (!uci || uci.length < 4) return null;
  const chess = new Chess(fen);
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return move ? { san: move.san, fen: chess.fen(), from: move.from as Key, to: move.to as Key } : null;
  } catch {
    return null;
  }
}

function moveFromSan(fen: string, san: string | null) {
  if (!san) return null;
  const chess = new Chess(fen);
  try {
    const move = chess.move(san);
    return move ? { san: move.san, fen: chess.fen(), from: move.from as Key, to: move.to as Key } : null;
  } catch {
    return null;
  }
}

export default function ComparePanel({ fen, playedSan, playerColor, maiaRating, humanRating, cpLoss }: {
  fen: string;
  playedSan: string | null;
  playerColor: "white" | "black";
  maiaRating: number | null;
  humanRating: number | null;
  cpLoss: number | null;
}) {
  const { infer } = useMaiaWorker(true);
  const [lines, setLines] = useState<CompareLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const movingColor = fen.split(" ")[1] === "b" ? "black" : "white";
  const ratedSelf = movingColor === playerColor ? humanRating : maiaRating;
  const ratedOpponent = movingColor === playerColor ? maiaRating : humanRating;
  const playedMove = useMemo(() => moveFromSan(fen, playedSan), [fen, playedSan]);

  useEffect(() => {
    let active = true;
    const engineTask = evalFenMultiPv(fen, 1);
    const maiaTask = infer(fen, ratedSelf, ratedOpponent).then((result) =>
      rerankMoves({ fen, logitsMaia: result.logitsMaia, opponentFeatures: {
        username: "", gamesAnalyzed: 0, mostCommonOpenings: [], queenTradeRate: 0.5,
        aggressionIndex: 0.5, avgRating: null, fetchedAt: 0,
      } })
    );

    void Promise.allSettled([engineTask, maiaTask]).then(async ([engineResult, maiaResult]) => {
      if (!active) return;
      const engineMove = engineResult.status === "fulfilled" ? moveFromUci(fen, engineResult.value[0]?.uci ?? null) : null;
      const maiaMove = moveFromUci(fen, maiaResult.status === "fulfilled" ? maiaResult.value.baseTopMove?.uci ?? null : null);
      const candidates = [
        { label: "Played", kind: "played" as const, move: playedMove },
        { label: "Stockfish", kind: "engine" as const, move: engineMove },
        { label: `Typical ${ratedSelf ?? "unknown"}-rated player`, kind: "maia" as const, move: maiaMove },
      ];
      const evaluations = await Promise.allSettled(candidates.map(({ move }) => move ? evalFen(move.fen) : Promise.resolve(null)));
      if (!active) return;
      setLines(candidates.map(({ label, kind, move }, index) => {
        const evaluation = evaluations[index];
        const result = evaluation?.status === "fulfilled" ? evaluation.value : null;
        return {
          label,
          kind,
          san: move?.san ?? null,
          fen: move?.fen ?? null,
          cpForPlayer: move && result ? playerEval(result, move.fen, playerColor) : null,
          from: move?.from ?? null,
          to: move?.to ?? null,
        };
      }));
      const issues = [
        engineResult.status === "rejected" ? "Stockfish is unavailable." : null,
        maiaResult.status === "rejected" ? `Maia is unavailable: ${maiaResult.reason instanceof Error ? maiaResult.reason.message : String(maiaResult.reason)}` : null,
        evaluations.some((result) => result.status === "rejected") ? "One or more resulting-position evaluations are unavailable." : null,
      ].filter((message): message is string => message !== null);
      if (issues.length) setError(issues.join(" "));
    });
    return () => { active = false; };
  }, [fen, infer, maiaRating, humanRating, playerColor, playedMove, ratedSelf, ratedOpponent]);

  const marker = (line: CompareLine | undefined) => line?.cpForPlayer === null || line?.cpForPlayer === undefined
    ? null
    : `${Math.max(0, Math.min(100, (Math.max(-1000, Math.min(1000, line.cpForPlayer)) + 1000) / 20))}%`;

  return <section aria-label="Move comparison" className="space-y-4">
    <header>
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Sliding Doors</p>
      <h2 className="mt-1 text-lg font-medium">What happened vs. alternatives</h2>
      <p className="mt-1 text-xs leading-5 text-neutral-500">Stockfish is an engine recommendation. Maia predicts typical play at the displayed rating; it is not your opponent.</p>
    </header>
    {cpLoss !== null && <p className="text-xs text-amber-100">Saved analysis recorded {Math.round(cpLoss)} cp loss on the played move.</p>}
    {error && <p role="status" className="text-xs text-amber-200">{error}</p>}
    {!lines ? <p role="status" className="py-8 text-center text-sm text-neutral-400">Comparing Stockfish, Maia, and the played move…</p> : <>
      <div className="relative h-8 rounded-full border border-white/10 bg-gradient-to-r from-rose-950 via-neutral-800 to-emerald-950" aria-label="Resulting evaluation from your perspective">
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
        {lines.map((line) => {
          const left = marker(line);
          return left ? <span key={line.kind} className={`absolute top-0 h-full w-1 ${line.kind === "played" ? "bg-rose-400" : line.kind === "engine" ? "bg-sky-300" : "bg-pink-300"}`} style={{ left }} title={`${line.label}: ${line.cpForPlayer === null ? "unavailable" : `${line.cpForPlayer > 0 ? "+" : ""}${(line.cpForPlayer / 100).toFixed(2)} pawns for you`}`} /> : null;
        })}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {lines.map((line) => <article key={line.kind} className="rounded-lg border border-white/10 bg-black/25 p-3">
          <p className="text-xs text-neutral-400">{line.label}</p>
          {line.fen ? <div className="mt-2"><ChessgroundBoard fen={line.fen} orientation={playerColor} /></div> : <p className="mt-2 grid aspect-square place-items-center text-xs text-neutral-600">Move unavailable</p>}
          <p className="mt-2 font-mono text-sm text-white">{line.san ?? "—"}</p>
          <p className="mt-1 text-[11px] text-neutral-500">{line.cpForPlayer === null ? "Evaluation unavailable" : `${line.cpForPlayer > 0 ? "+" : ""}${(line.cpForPlayer / 100).toFixed(2)} pawns for you`}</p>
          {line.kind === "maia" && <p className="mt-1 text-[10px] text-pink-300/80">Behavior prediction, not engine analysis.</p>}
        </article>)}
      </div>
    </>}
  </section>;
}
