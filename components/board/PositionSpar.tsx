"use client";

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import { useMaiaWorker, type MaiaInferenceResult } from "@/lib/maia/useMaiaWorker";
import { gamePhaseFromFen, rerankMoves } from "@/lib/maia/rerank";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import { loadOpponentMimicProfiles } from "@/lib/profile/opponentMimicProfiles";
import type { OpeningTree, OpponentTimePressureProfile, PieceActivityProfile } from "@/types";
import ChessgroundBoard from "./ChessgroundBoard";

interface SparBoardProps {
  fen: string;
  orientation: "white" | "black";
  interactive: boolean;
  turnColor: "white" | "black";
  dests?: Map<Key, Key[]>;
  lastMove?: [Key, Key];
  onUserMove: (from: Key, to: Key) => void;
}

type SparStatus = "loading-style" | "your-turn" | "maia-thinking" | "error" | "game-over";
type SparMode = "maia" | "mimic";
const NEUTRAL_FEATURES: OpponentFeatures = {
  username: "",
  gamesAnalyzed: 0,
  mostCommonOpenings: [],
  queenTradeRate: 0.5,
  aggressionIndex: 0.5,
  avgRating: null,
  fetchedAt: 0,
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Maia inference timed out.")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function weightedSample<T extends { adjustedProbability: number }>(moves: T[]): T | null {
  if (moves.length === 0) return null;
  const total = moves.reduce((sum, move) => sum + move.adjustedProbability, 0);
  if (total <= 0) return moves[0];
  let random = Math.random() * total;
  for (const move of moves) {
    random -= move.adjustedProbability;
    if (random <= 0) return move;
  }
  return moves[moves.length - 1];
}

/** Starts a fresh Maia spar from the exact FEN currently displayed by a board. */
export default function PositionSpar({
  fen,
  humanColor,
  maiaRating,
  humanRating,
  opponentUsername,
  prewarmMimic = true,
  prewarmMaia = true,
  inferOverride,
  viewLastMove,
  boardClassName = "mx-auto w-full max-w-[480px] overflow-hidden rounded-lg border border-white/10 bg-[#1b1a18] p-1",
}: {
  fen: string;
  humanColor: "white" | "black";
  maiaRating: number | null;
  humanRating: number | null;
  opponentUsername?: string;
  prewarmMimic?: boolean;
  prewarmMaia?: boolean;
  inferOverride?: (fen: string, selfRating: number | null, oppRating: number | null) => Promise<MaiaInferenceResult>;
  viewLastMove?: [Key, Key];
  boardClassName?: string;
}) {
  const localMaia = useMaiaWorker(!inferOverride);
  const infer = inferOverride ?? localMaia.infer;
  const chessRef = useRef<Chess | null>(null);
  const sessionRef = useRef(0);
  const activeModeRef = useRef<SparMode>("maia");
  const warmInferenceRef = useRef<{
    fen: string;
    selfRating: number | null;
    oppRating: number | null;
    promise: ReturnType<typeof infer>;
  } | null>(null);
  const pieceActivityRef = useRef<PieceActivityProfile | null>(null);
  const openingTreeRef = useRef<OpeningTree | null>(null);
  const timePressureRef = useRef<OpponentTimePressureProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [sparMode, setSparMode] = useState<SparMode>("maia");
  const [activeSparMode, setActiveSparMode] = useState<SparMode>("maia");
  const [status, setStatus] = useState<SparStatus>("your-turn");
  const [sparFen, setSparFen] = useState(fen);
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>();
  const [dests, setDests] = useState<Map<Key, Key[]> | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [styleNotice, setStyleNotice] = useState<string | null>(null);
  const [mimicWarmState, setMimicWarmState] = useState<"idle" | "warming" | "ready" | "partial">(
    prewarmMimic && opponentUsername && opponentUsername.toLowerCase() !== "anonymous" ? "warming" : "idle"
  );
  const [maiaWarmState, setMaiaWarmState] = useState<"idle" | "warming" | "ready" | "unavailable">(
    prewarmMaia ? "warming" : "idle"
  );
  const canMimic = !!opponentUsername && opponentUsername.toLowerCase() !== "anonymous";

  function legalDests(chess: Chess) {
    const dests = new Map<Key, Key[]>();
    for (const move of chess.moves({ verbose: true })) {
      const from = move.from as Key;
      const squares = dests.get(from) ?? [];
      squares.push(move.to as Key);
      dests.set(from, squares);
    }
    return dests;
  }

  function finishIfOver(chess: Chess) {
    if (!chess.isGameOver()) return false;
    setStatus("game-over");
    return true;
  }

  // Cue the expensive bits while the player is inspecting this saved game.
  // The spar itself remains opt-in; this only primes the model and builds
  // opponent profiles into the existing browser caches in the background.
  // Deliberately mount-only: the board's first inspected position primes Maia.
  useEffect(() => {
    let cancelled = false;
    let warmPromise: Promise<unknown> = Promise.resolve();
    if (prewarmMaia) {
      const initialFen = fen;
      const promise = withTimeout(infer(initialFen, maiaRating, humanRating), 60_000);
      warmInferenceRef.current = { fen: initialFen, selfRating: maiaRating, oppRating: humanRating, promise };
      warmPromise = promise.then(() => {
        if (!cancelled) setMaiaWarmState("ready");
      }).catch((err) => {
        if (warmInferenceRef.current?.promise === promise) warmInferenceRef.current = null;
        if (!cancelled) setMaiaWarmState("unavailable");
        console.info("Maia background warm-up did not complete:", err);
      });
    }
    if (prewarmMimic && canMimic && opponentUsername) {
      warmPromise = warmPromise.then(() => cancelled ? null : loadOpponentMimicProfiles(opponentUsername)).then((profiles) => {
        if (!profiles || cancelled) return;
        setMimicWarmState(profiles.notice ? "partial" : "ready");
        setStyleNotice(profiles.notice);
      });
    }
    void warmPromise.catch((err) => {
      if (cancelled) return;
      setMimicWarmState("partial");
      setStyleNotice(err instanceof Error ? err.message : "Some mimic data could not be prepared.");
    });
    // Warm only the first inspected position; changing the move cursor must
    // not trigger a fresh model inference for every board position.
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function playMaia(chess: Chess, session: number) {
    const isStale = () => sessionRef.current !== session;
    setStatus("maia-thinking");
    setErrorMessage(null);
    try {
      const inferenceFen = chess.fen();
      const warm = warmInferenceRef.current;
      const warmed = warm?.fen === inferenceFen && warm.selfRating === maiaRating && warm.oppRating === humanRating
        ? warm.promise
        : null;
      if (warmed) warmInferenceRef.current = null;
      const inference = await (warmed ?? withTimeout(infer(inferenceFen, maiaRating, humanRating), 60_000));
      if (isStale()) return;
      const mimic = activeModeRef.current === "mimic";
      const timePressure = mimic ? timePressureRef.current : null;
      const phase = gamePhaseFromFen(new Chess(inferenceFen));
      const phaseBucket = timePressure?.byPhase[phase] ?? null;
      const collapsing = !!phaseBucket && phaseBucket.confidence !== "low" && Math.random() < phaseBucket.collapseRate;
      const result = await rerankMoves({
        fen: inferenceFen,
        logitsMaia: inference.logitsMaia,
        opponentFeatures: NEUTRAL_FEATURES,
        pieceActivityProfile: mimic ? pieceActivityRef.current : null,
        openingTree: mimic ? openingTreeRef.current : null,
      });
      if (isStale()) return;

      const delay = collapsing
        ? 300 + Math.random() * 400
        : phaseBucket?.phaseAvgSec
          ? Math.min(9_000, Math.max(1_000, phaseBucket.phaseAvgSec * 1_000))
          : 1_000 + Math.random() * 2_000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (isStale()) return;

      const sampled = collapsing ? weightedSample(result.moves) : null;
      const uci = sampled?.uci ?? result.topMove?.uci ?? result.baseTopMove?.uci;
      if (!uci) {
        setStatus("game-over");
        return;
      }
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4) : undefined,
      });
      if (!move) throw new Error("Maia returned no legal move for this position.");
      chessRef.current = chess;
      setLastMove([move.from as Key, move.to as Key]);
      setSparFen(chess.fen());
      if (!finishIfOver(chess)) {
        setDests(legalDests(chess));
        setStatus("your-turn");
      }
    } catch (err) {
      if (isStale()) return;
      console.error("Maia spar move failed:", err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function startSpar() {
    const session = ++sessionRef.current;
    const selectedMode: SparMode = sparMode === "mimic" && canMimic ? "mimic" : "maia";
    activeModeRef.current = selectedMode;
    setActiveSparMode(selectedMode);
    const chess = new Chess(fen);
    chessRef.current = chess;
    setSparFen(chess.fen());
    setLastMove(undefined);
    setErrorMessage(null);
    setOpen(true);
    setDests(undefined);
    setStyleNotice(null);
    if (finishIfOver(chess)) return;

    // Build the same local opponent profiles used by GamePanel's mimicry
    // replay. Keep the Lichess-dependent work sequential to respect its API
    // rate limits; IndexedDB and eval caches make later spars much quicker.
    if (selectedMode === "mimic" && opponentUsername && opponentUsername.toLowerCase() !== "anonymous") {
      setStatus("loading-style");
      const profiles = await loadOpponentMimicProfiles(opponentUsername);
      if (sessionRef.current !== session) return;
      pieceActivityRef.current = profiles.pieceActivity;
      openingTreeRef.current = profiles.openingTree;
      timePressureRef.current = profiles.timePressure;
      setStyleNotice(profiles.notice);
      setMimicWarmState(profiles.notice ? "partial" : "ready");
    }

    if (chess.turn() === (humanColor === "white" ? "w" : "b")) {
      setDests(legalDests(chess));
      setStatus("your-turn");
    } else {
      void playMaia(chess, session);
    }
  }

  function closeSpar() {
    sessionRef.current++;
    chessRef.current = null;
    setOpen(false);
    setErrorMessage(null);
  }

  function onUserMove(from: Key, to: Key) {
    const chess = chessRef.current;
    if (!chess || status !== "your-turn") return;
    let move;
    try {
      move = chess.move({ from, to, promotion: "q" });
    } catch {
      return;
    }
    if (!move) return;
    setSparFen(chess.fen());
    setLastMove([move.from as Key, move.to as Key]);
    setDests(undefined);
    if (finishIfOver(chess)) return;
    void playMaia(chess, sessionRef.current);
  }

  const boardFen = open ? sparFen : fen;
  const boardProps: SparBoardProps = {
    fen: boardFen,
    orientation: humanColor,
    interactive: open && status === "your-turn",
    turnColor: boardFen.split(" ")[1] === "b" ? "black" : "white",
    dests: open && status === "your-turn" ? dests : undefined,
    lastMove: open ? lastMove : viewLastMove,
    onUserMove,
  };

  return (
    <>
      <div className={boardClassName}>
        <ChessgroundBoard {...boardProps} />
      </div>
      <section className="rounded-xl border border-white/10 bg-black/30 p-4">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="w-full">
            <p className="text-sm text-neutral-200">Play this position</p>
            <p className="mt-1 text-xs text-neutral-500">Choose Maia’s baseline play or ask Maia to mimic this game’s opponent.</p>
            {maiaWarmState === "warming" && <p className="mt-2 text-[10px] text-neutral-500" aria-live="polite">Warming Maia’s local model in the background…</p>}
            {maiaWarmState === "unavailable" && <p className="mt-2 text-[10px] text-amber-200/80">Maia could not prewarm; it will initialize when you start the spar.</p>}
            {canMimic && <p className="mt-2 text-[10px] text-neutral-500" aria-live="polite">{mimicWarmState === "warming" ? `Preparing ${opponentUsername}’s style in the background…` : mimicWarmState === "ready" ? `${opponentUsername}’s mimic profile is ready.` : mimicWarmState === "partial" ? "Mimic profile is partially available; unavailable signals will be skipped." : "Mimic data will be prepared in the background."}</p>}
            <fieldset className="mt-4">
              <legend className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">Spar style</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`cursor-pointer rounded-lg border p-3 transition ${sparMode === "maia" ? "border-emerald-300/40 bg-emerald-300/10" : "border-white/10 hover:border-white/20"}`}>
                  <input className="sr-only" type="radio" name="spar-mode" value="maia" checked={sparMode === "maia"} onChange={() => setSparMode("maia")} />
                  <span className="block text-xs text-neutral-100">Maia</span>
                  <span className="mt-1 block text-[10px] leading-4 text-neutral-500">Rating-conditioned Maia, without opponent-specific style adjustments.</span>
                </label>
                <label className={`cursor-pointer rounded-lg border p-3 transition ${sparMode === "mimic" ? "border-violet-300/40 bg-violet-300/10" : "border-white/10 hover:border-white/20"} ${!canMimic ? "cursor-not-allowed opacity-50" : ""}`}>
                  <input className="sr-only" type="radio" name="spar-mode" value="mimic" checked={sparMode === "mimic"} onChange={() => setSparMode("mimic")} disabled={!canMimic} />
                  <span className="block text-xs text-neutral-100">Mimic {opponentUsername ? opponentUsername : "opponent"}</span>
                  <span className="mt-1 block text-[10px] leading-4 text-neutral-500">Uses this opponent’s opening, piece-activity, and time-pressure profile.</span>
                </label>
              </div>
            </fieldset>
          </div>
          <button type="button" onClick={() => void startSpar()} className="shrink-0 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-xs text-emerald-100 hover:bg-emerald-300/20">Spar from here</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm text-neutral-100">Sparring from this position</p><p className="mt-1 text-xs text-neutral-500">You play {humanColor}; {activeSparMode === "mimic" && opponentUsername ? `Maia mimics ${opponentUsername}` : "Maia uses its baseline style"}.</p></div>
            <button type="button" onClick={closeSpar} className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Close</button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <p aria-live="polite" className="text-neutral-300">
              {status === "loading-style" && "Loading opponent style locally. First-time profiling may take a while…"}
              {status === "your-turn" && "Your move"}
              {status === "maia-thinking" && "Maia is thinking…"}
              {status === "error" && (errorMessage ?? "Maia could not move.")}
              {status === "game-over" && "Game over"}
            </p>
            <div className="flex gap-2">
              {status === "error" && <button type="button" onClick={() => chessRef.current && void playMaia(chessRef.current, sessionRef.current)} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Retry Maia</button>}
              {status === "game-over" && <button type="button" onClick={startSpar} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Restart from position</button>}
            </div>
          </div>
          {styleNotice && <p className="text-[11px] leading-5 text-amber-200/80">{styleNotice}</p>}
        </div>
      )}
      </section>
    </>
  );
}
