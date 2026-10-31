"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import { isMaiaWorkerStopped, useMaiaWorker, type MaiaInferenceResult } from "@/lib/maia/useMaiaWorker";
import { selectTopLegalMaiaMove } from "@/lib/maia/selectLegalMove";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import { loadOpponentMimicProfiles } from "@/lib/profile/opponentMimicProfiles";
import { resolveOpponentTier } from "@/lib/opponent/resolveTier";
import { openingTreeHitsAt, openingTreeMove } from "@/lib/profile/openingTree";
import { evalFenMultiPv } from "@/lib/eval/stockfishEngine";
import type { OpeningTree } from "@/types";
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
function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Maia inference timed out.")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Starts a fresh Maia spar from the exact FEN currently displayed by a board. */
export default function PositionSpar({
  fen,
  humanColor,
  maiaRating,
  humanRating,
  opponentUsername,
  opponentFeatures,
  effectiveRatingFires = false,
  openingTree,
  prewarmMimic = true,
  prewarmMaia = true,
  inferOverride,
  viewLastMove,
  resolution,
  showPreviewBoard = true,
  autoStart = false,
  showControls = true,
  inlineSpar = false,
  onOpenChange,
  boardClassName = "mx-auto w-full max-w-[480px] overflow-hidden rounded-lg border border-white/10 bg-[#1b1a18] p-1",
}: {
  fen: string;
  humanColor: "white" | "black";
  maiaRating: number | null;
  humanRating: number | null;
  opponentUsername?: string;
  opponentFeatures?: OpponentFeatures | null;
  effectiveRatingFires?: boolean;
  openingTree?: OpeningTree | null;
  prewarmMimic?: boolean;
  prewarmMaia?: boolean;
  inferOverride?: (fen: string, selfRating: number | null, oppRating: number | null) => Promise<MaiaInferenceResult>;
  viewLastMove?: [Key, Key];
  resolution?: { gameId: string; ply: number } | null;
  showPreviewBoard?: boolean;
  autoStart?: boolean;
  showControls?: boolean;
  inlineSpar?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  const openingTreeRef = useRef<OpeningTree | null>(null);
  const [open, setOpen] = useState(false);
  const [sparMode, setSparMode] = useState<SparMode>("maia");
  const [userChoseMode, setUserChoseMode] = useState(false);
  const [activeSparMode, setActiveSparMode] = useState<SparMode>("maia");
  const [status, setStatus] = useState<SparStatus>("your-turn");
  const [sparFen, setSparFen] = useState(fen);
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>();
  const [dests, setDests] = useState<Map<Key, Key[]> | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const resolutionAttemptedRef = useRef(false);
  const autoStartHandledRef = useRef(false);
  const assistSessionRef = useRef(0);
  const assistWasUsedRef = useRef(false);
  const [assistEnabled, setAssistEnabled] = useState(false);
  const [assistLine, setAssistLine] = useState<{ san: string | null; cp: number | null; mate: number | null; fen: string | null; from: Key | null; to: Key | null } | null>(null);
  const [styleNotice, setStyleNotice] = useState<string | null>(null);
  const [mimicWarmState, setMimicWarmState] = useState<"idle" | "warming" | "ready" | "partial">(
    prewarmMimic && opponentUsername && opponentUsername.toLowerCase() !== "anonymous" ? "warming" : "idle"
  );
  const [maiaWarmState, setMaiaWarmState] = useState<"idle" | "warming" | "ready" | "unavailable">(
    prewarmMaia ? "warming" : "idle"
  );
  const [tierProfiles, setTierProfiles] = useState<{ openingTree: OpeningTree | null } | null>(null);
  const hasOpponent = !!opponentUsername && opponentUsername.toLowerCase() !== "anonymous";
  const tier = useMemo(() => hasOpponent ? resolveOpponentTier({
    effectiveRatingFires,
    openingTreeHits: openingTreeHitsAt(tierProfiles?.openingTree ?? openingTree, fen),
    opponentGamesAnalyzed: opponentFeatures?.gamesAnalyzed ?? 0,
  }) : null, [effectiveRatingFires, fen, hasOpponent, openingTree, opponentFeatures, tierProfiles]);
  const canMimic = hasOpponent && (tier?.tier === 1 || tier?.tier === 2);
  // Opponent mimicry uses exact opening history, then rating-conditioned Base Maia.
  const displayedMode: SparMode = !userChoseMode ? "maia" : canMimic || sparMode === "maia" ? sparMode : "maia";
  const modeledGameCount = tierProfiles?.openingTree?.gamesEvaluated ?? openingTree?.gamesEvaluated ?? 0;
  const closeSpar = useCallback(() => {
    sessionRef.current++;
    assistSessionRef.current++;
    chessRef.current = null;
    setOpen(false);
    onOpenChange?.(false);
    setErrorMessage(null);
    setAssistEnabled(false);
    setAssistLine(null);
    assistWasUsedRef.current = false;
  }, [onOpenChange]);

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

  async function saveResolution(outcome: "win" | "draw") {
    if (!resolution || resolutionAttemptedRef.current) return;
    if (assistWasUsedRef.current) {
      setResolutionMessage("Stockfish assist was shown, so this result will not mark the position resolved. Restart and play without the hint to verify it.");
      return;
    }
    resolutionAttemptedRef.current = true;
    setResolutionMessage("Saving resolved position…");
    try {
      const response = await fetch("/api/spar/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...resolution, outcome }),
      });
      if (!response.ok) throw new Error("Could not save the resolved position.");
      setResolutionMessage("Win or draw saved. This position is resolved.");
      window.dispatchEvent(new CustomEvent("spar-position-resolved", { detail: resolution }));
    } catch (error) {
      resolutionAttemptedRef.current = false;
      setResolutionMessage(error instanceof Error ? error.message : "Could not save the resolved position.");
    }
  }

  function finishIfOver(chess: Chess) {
    if (!chess.isGameOver()) return false;
    setStatus("game-over");
    if (chess.history().length > 0) {
      if (chess.isDraw()) void saveResolution("draw");
      else if (chess.isCheckmate() && chess.turn() !== (humanColor === "white" ? "w" : "b")) {
        void saveResolution("win");
      }
    }
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
        openingTreeRef.current = profiles.openingTree;
        setTierProfiles({ openingTree: profiles.openingTree });
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

  useEffect(() => {
    if (!open || inlineSpar) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSpar();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, inlineSpar, closeSpar]);

  async function playMaia(chess: Chess, session: number) {
    const isStale = () => sessionRef.current !== session;
    const shouldAssist = assistEnabled;
    const assistRequest = assistSessionRef.current;
    setStatus("maia-thinking");
    setErrorMessage(null);
    try {
      const inferenceFen = chess.fen();
      const mimic = activeModeRef.current === "mimic";
      const fenFields = inferenceFen.split(" ");
      const fullmove = Number.parseInt(fenFields[5] ?? "1", 10) || 1;
      const positionPly = (fullmove - 1) * 2 + (fenFields[1] === "b" ? 1 : 0);
      const treeUci = mimic && positionPly < 12 ? openingTreeMove(openingTreeRef.current, inferenceFen) : null;
      const treeMoveIsLegal = !!treeUci && chess.moves({ verbose: true }).some((move) =>
        move.from + move.to + (move.promotion ?? "") === treeUci,
      );
      let uci: string | null = treeMoveIsLegal ? treeUci! : null;
      if (!uci) {
        const warm = warmInferenceRef.current;
        const warmed = warm?.fen === inferenceFen && warm.selfRating === maiaRating && warm.oppRating === humanRating
          ? warm.promise
          : null;
        if (warmed) warmInferenceRef.current = null;
        const inference = await (warmed ?? withTimeout(infer(inferenceFen, maiaRating, humanRating), 60_000));
        if (isStale()) return;
        uci = await selectTopLegalMaiaMove(inferenceFen, inference.logitsMaia);
        if (isStale()) return;
        const delay = 1_000 + Math.random() * 2_000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (isStale()) return;
      }
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
      console.info("Maia spar move", {
        usedOpeningTree: treeMoveIsLegal,
        openingMove: treeMoveIsLegal ? uci : null,
        rerankerApplied: false,
      });
      chessRef.current = chess;
      setLastMove([move.from as Key, move.to as Key]);
      setSparFen(chess.fen());
      if (!finishIfOver(chess)) {
        setDests(legalDests(chess));
        setStatus("your-turn");
        if (shouldAssist) void runAssist(chess.fen(), session, assistRequest);
      }
    } catch (err) {
      if (isStale() || isMaiaWorkerStopped(err)) return;
      console.error("Maia spar move failed:", err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function runAssist(
    fenAfterBotMove: string,
    session: number,
    request: number,
  ) {
    try {
      const afterLines = await evalFenMultiPv(fenAfterBotMove, 1);
      if (request !== assistSessionRef.current || sessionRef.current !== session) return;
      if (chessRef.current?.fen() !== fenAfterBotMove) return;
      const top = afterLines[0];
      let san: string | null = null;
      let bestReplyFen: string | null = null;
      let from: Key | null = null;
      let to: Key | null = null;
      if (top?.uci) {
        const reply = new Chess(fenAfterBotMove);
        const move = reply.move({ from: top.uci.slice(0, 2), to: top.uci.slice(2, 4), promotion: top.uci.slice(4) || undefined });
        san = move?.san ?? null;
        if (move) {
          bestReplyFen = reply.fen();
          from = move.from as Key;
          to = move.to as Key;
        }
      }
      setAssistLine({ san, cp: top?.cp ?? null, mate: top?.mate ?? null, fen: bestReplyFen, from, to });
      if (san && bestReplyFen) assistWasUsedRef.current = true;
    } catch {
      if (request === assistSessionRef.current && sessionRef.current === session) setAssistLine(null);
    }
  }

  async function startSpar() {
    const session = ++sessionRef.current;
    assistSessionRef.current++;
    assistWasUsedRef.current = false;
    setAssistLine(null);
    const selectedMode: SparMode = displayedMode === "mimic" && canMimic ? "mimic" : "maia";
    activeModeRef.current = selectedMode;
    setActiveSparMode(selectedMode);
    const chess = new Chess(fen);
    chessRef.current = chess;
    setSparFen(chess.fen());
    setLastMove(undefined);
    setErrorMessage(null);
    setResolutionMessage(null);
    resolutionAttemptedRef.current = false;
    setOpen(true);
    onOpenChange?.(true);
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
      openingTreeRef.current = profiles.openingTree;
      setTierProfiles({ openingTree: profiles.openingTree });
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

  useEffect(() => {
    if (!autoStart || autoStartHandledRef.current) return;
    autoStartHandledRef.current = true;
    void startSpar();
    // autoStart is a mount-time command; do not rerun for the function's render-time identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

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
      {!open && showPreviewBoard && <div className={boardClassName}>
        <ChessgroundBoard {...boardProps} />
      </div>}
      {!open && showControls && <section className="rounded-xl border border-white/10 bg-black/30 p-4">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="w-full">
            <p className="text-sm text-neutral-200">Play this position</p>
            <p className="mt-1 text-xs text-neutral-500">Choose rating-conditioned Maia or mimic this opponent's opening history, then continue as rating-conditioned Maia.</p>
            {maiaWarmState === "warming" && <p className="mt-2 text-[10px] text-neutral-500" aria-live="polite">Warming Maia’s local model in the background…</p>}
            {maiaWarmState === "unavailable" && <p className="mt-2 text-[10px] text-amber-200/80">Maia could not prewarm; it will initialize when you start the spar.</p>}
            {canMimic && <p className="mt-2 text-[10px] text-neutral-500" aria-live="polite">{mimicWarmState === "warming" ? `Preparing ${opponentUsername}’s opening history in the background…` : mimicWarmState === "ready" ? `${opponentUsername}’s opening history is ready.` : mimicWarmState === "partial" ? "Opening history is unavailable; rating-conditioned Maia will be used." : "Opponent opening history will be loaded in the background."}</p>}
            <fieldset className="mt-4">
              <legend className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">Spar style</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`cursor-pointer rounded-lg border p-3 transition ${displayedMode === "maia" ? "border-emerald-300/40 bg-emerald-300/10" : "border-white/10 hover:border-white/20"}`}>
                  <input className="sr-only" type="radio" name="spar-mode" value="maia" checked={displayedMode === "maia"} onChange={() => { setUserChoseMode(true); setSparMode("maia"); }} />
                  <span className="block text-xs text-neutral-100">Maia</span>
                  <span className="mt-1 block text-[10px] leading-4 text-neutral-500">Rating-conditioned Maia throughout the game.</span>
                </label>
                <label className={`cursor-pointer rounded-lg border p-3 transition ${displayedMode === "mimic" ? "border-violet-300/40 bg-violet-300/10" : "border-white/10 hover:border-white/20"} ${!canMimic ? "cursor-not-allowed opacity-50" : ""}`}>
                  <input className="sr-only" type="radio" name="spar-mode" value="mimic" checked={displayedMode === "mimic"} onChange={() => { setUserChoseMode(true); setSparMode("mimic"); }} disabled={!canMimic} />
                  <span className="block text-xs text-neutral-100">Mimic {opponentUsername ? opponentUsername : "opponent"}</span>
                  <span className="mt-1 block text-[10px] leading-4 text-neutral-500">
                    {tier?.tier === 1 && "Plays this opponent's actual opening moves from their game history, then continues as rating-conditioned Maia."}
                    {tier?.tier === 2 && "Plays this opponent's actual opening moves from their game history, then continues as rating-conditioned Maia."}
                    {(!tier || tier.tier === 3) && "Not enough matchup data to enable mimic yet."}
                  </span>
                </label>
              </div>
            </fieldset>
          </div>
          <button type="button" onClick={() => void startSpar()} className="shrink-0 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-xs text-emerald-100 hover:bg-emerald-300/20">Spar from here</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm text-neutral-100">Sparring from this position</p><p className="mt-1 text-xs text-neutral-500">You play {humanColor}; {activeSparMode === "mimic" && opponentUsername ? `Mimics ${opponentUsername}'s opening history, then uses rating-conditioned Maia` : "Maia uses rating-conditioned play"}.</p>
              {activeSparMode === "mimic" && opponentUsername && tier && tier.tier < 3
                ? <span className="mt-2 inline-flex rounded-full border border-violet-300/25 bg-violet-300/10 px-2.5 py-1 text-[10px] text-violet-100">Opening-tree mimic: {opponentUsername}{modeledGameCount > 0 ? ` · ${modeledGameCount} games` : " · opening history active"}</span>
                : <span className="mt-2 inline-flex rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] text-neutral-300">Base Maia</span>}
            </div>
            <button type="button" onClick={closeSpar} className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Close</button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <p aria-live="polite" className="text-neutral-300">
              {status === "loading-style" && "Loading opponent opening history…"}
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
          {resolution && resolutionMessage && <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-400" aria-live="polite">
            <span>{resolutionMessage}</span>
            {resolutionMessage.startsWith("Could not save") && <button type="button" onClick={() => void saveResolution(chessRef.current?.isDraw() ? "draw" : "win")} className="underline hover:text-white">Retry save</button>}
          </div>}
          {styleNotice && <p className="text-[11px] leading-5 text-amber-200/80">{styleNotice}</p>}
        </div>
      )}
      </section>}
      {open && (inlineSpar ? (
        <section aria-labelledby="position-spar-title" className="w-full rounded-xl border border-emerald-300/20 bg-black/35 p-3 sm:p-4">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id="position-spar-title" className="text-base font-medium text-white">Spar from this position</h2>
              <p className="mt-1 text-xs text-neutral-400">You play {humanColor}; {activeSparMode === "mimic" && opponentUsername ? `Mimics ${opponentUsername}'s opening history, then uses rating-conditioned Maia` : "Maia uses rating-conditioned play"}.</p>
              {activeSparMode === "mimic" && opponentUsername && tier && tier.tier < 3
                ? <span className="mt-2 inline-flex rounded-full border border-violet-300/25 bg-violet-300/10 px-2.5 py-1 text-[10px] text-violet-100">Opening-tree mimic: {opponentUsername}{modeledGameCount > 0 ? ` · ${modeledGameCount} games` : " · opening history active"}</span>
                : <span className="mt-2 inline-flex rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] text-neutral-300">Base Maia</span>}
            </div>
            <button type="button" onClick={closeSpar} className="shrink-0 rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Back to game review</button>
          </div>
          <div className={boardClassName}>
            <ChessgroundBoard {...boardProps}
              ghostLayers={assistEnabled && assistLine?.fen ? [{ fen: assistLine.fen, tint: "#38bdf8", opacity: 0.58, label: "Stockfish best move" }] : undefined}
              ghostArrows={assistEnabled && assistLine?.from && assistLine.to ? [{ from: assistLine.from, to: assistLine.to, tint: "#38bdf8", label: "Stockfish best move" }] : undefined} />
          </div>
          <div className="mt-3 space-y-2 text-xs">
            <label className="flex items-center gap-2 text-neutral-300">
              <input type="checkbox" checked={assistEnabled} onChange={(event) => {
                const enabled = event.target.checked;
                assistSessionRef.current++;
                setAssistEnabled(enabled);
                setAssistLine(null);
                if (enabled && status === "your-turn" && chessRef.current) {
                  void runAssist(chessRef.current.fen(), sessionRef.current, assistSessionRef.current);
                }
              }} />
              Show Stockfish&apos;s best move for you
            </label>
            {assistEnabled && <p className="text-neutral-400">Engine assist: the blue arrow and ghost piece show Stockfish&apos;s top move for your turn. Once a hint appears, a win or draw here won&apos;t count as resolving the position.</p>}
            {assistEnabled && assistLine && <p className="text-sky-300" aria-live="polite">Stockfish&apos;s top move for you: <strong>{assistLine.san ?? "unavailable"}</strong>{assistLine.mate !== null ? ` (mate in ${Math.abs(assistLine.mate)} ${assistLine.mate > 0 ? "for you" : "against you"})` : assistLine.cp !== null ? ` (${assistLine.cp > 0 ? "+" : ""}${(assistLine.cp / 100).toFixed(2)} pawns for you)` : ""}.</p>}
            <p aria-live="polite" className="text-neutral-300">
              {status === "loading-style" && "Loading opponent opening history…"}
              {status === "your-turn" && "Your move"}
              {status === "maia-thinking" && "Maia is thinking…"}
              {status === "error" && (errorMessage ?? "Maia could not move.")}
              {status === "game-over" && "Game over"}
            </p>
            {status === "error" && <button type="button" onClick={() => chessRef.current && void playMaia(chessRef.current, sessionRef.current)} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Retry Maia</button>}
            {status === "game-over" && <button type="button" onClick={startSpar} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Restart from position</button>}
            {resolution && resolutionMessage && <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-400" aria-live="polite"><span>{resolutionMessage}</span>{resolutionMessage.startsWith("Could not save") && <button type="button" onClick={() => void saveResolution(chessRef.current?.isDraw() ? "draw" : "win")} className="underline hover:text-white">Retry save</button>}</div>}
            {styleNotice && <p className="text-[11px] leading-5 text-amber-200/80">{styleNotice}</p>}
          </div>
        </section>
      ) : open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[1000] overflow-y-auto bg-black/85 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSpar(); }}>
          <div className="mx-auto flex min-h-full max-w-3xl items-center justify-center">
            <section role="dialog" aria-modal="true" aria-labelledby="position-spar-title" className="w-full rounded-2xl border border-white/10 bg-[#11110f] p-4 shadow-2xl sm:p-6">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 id="position-spar-title" className="text-base font-medium text-white">Spar from this position</h2>
                  <p className="mt-1 text-xs text-neutral-400">You play {humanColor}; {activeSparMode === "mimic" && opponentUsername ? `Mimics ${opponentUsername}'s opening history, then uses rating-conditioned Maia` : "Maia uses rating-conditioned play"}.</p>
                </div>
                <button type="button" onClick={closeSpar} className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5">Close</button>
              </div>
              <div className={boardClassName}>
                <ChessgroundBoard {...boardProps}
                  ghostLayers={assistEnabled && assistLine?.fen ? [{ fen: assistLine.fen, tint: "#38bdf8", opacity: 0.58, label: "Stockfish best move" }] : undefined}
                  ghostArrows={assistEnabled && assistLine?.from && assistLine.to ? [{ from: assistLine.from, to: assistLine.to, tint: "#38bdf8", label: "Stockfish best move" }] : undefined} />
              </div>
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-neutral-300">
                    <input type="checkbox" checked={assistEnabled} onChange={(event) => {
                      const enabled = event.target.checked;
                      assistSessionRef.current++;
                      setAssistEnabled(enabled);
                      setAssistLine(null);
                      if (enabled && status === "your-turn" && chessRef.current) {
                        void runAssist(chessRef.current.fen(), sessionRef.current, assistSessionRef.current);
                      }
                    }} />
                    Show Stockfish&apos;s best move for you
                  </label>
                </div>
                {assistEnabled && <p className="text-neutral-400">Engine assist: the blue arrow and ghost piece show Stockfish&apos;s top move for your turn. Once a hint appears, a win or draw here won&apos;t count as resolving the position.</p>}
                {assistEnabled && assistLine && <p className="text-sky-300" aria-live="polite">
                  Stockfish&apos;s top move for you: <strong>{assistLine.san ?? "unavailable"}</strong>
                  {assistLine.mate !== null ? ` (mate in ${Math.abs(assistLine.mate)} ${assistLine.mate > 0 ? "for you" : "against you"})` : assistLine.cp !== null ? ` (${assistLine.cp > 0 ? "+" : ""}${(assistLine.cp / 100).toFixed(2)} pawns for you)` : ""}.
                </p>}
                <p aria-live="polite" className="text-neutral-300">
                  {status === "loading-style" && "Loading opponent opening history…"}
                  {status === "your-turn" && "Your move"}
                  {status === "maia-thinking" && "Maia is thinking…"}
                  {status === "error" && (errorMessage ?? "Maia could not move.")}
                  {status === "game-over" && "Game over"}
                </p>
                {status === "error" && <button type="button" onClick={() => chessRef.current && void playMaia(chessRef.current, sessionRef.current)} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Retry Maia</button>}
                {status === "game-over" && <button type="button" onClick={startSpar} className="rounded border border-white/10 px-3 py-1.5 text-neutral-300 hover:text-white">Restart from position</button>}
                {resolution && resolutionMessage && <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-400" aria-live="polite">
                  <span>{resolutionMessage}</span>
                  {resolutionMessage.startsWith("Could not save") && <button type="button" onClick={() => void saveResolution(chessRef.current?.isDraw() ? "draw" : "win")} className="underline hover:text-white">Retry save</button>}
                </div>}
                {styleNotice && <p className="text-[11px] leading-5 text-amber-200/80">{styleNotice}</p>}
              </div>
            </section>
          </div>
        </div>,
        document.body,
      ))}
    </>
  );
}
