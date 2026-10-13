"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessgroundBoard from "./ChessgroundBoard";
import UsernameForm from "./UsernameForm";
import VerdictCard from "./VerdictCard";
import { dismissalId, loadDismissed, saveDismissed } from "@/lib/dismissals";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import { useOpponentFeatures } from "@/lib/useOpponentFeatures";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import { extractAllMoveFeatures, buildPlayerProfile } from "@/lib/features/extractFeatures";
import { flagMoves } from "@/lib/flags/flagEngine";
import { runBackgroundEval } from "@/lib/onboarding/backgroundEval";
import { getCachedEval } from "@/lib/eval/evalCache";
import { emptyProfile, getProfile } from "@/lib/profile/profileCache";
 

import { appendAttempt, loadAttempts } from "@/lib/attemptLog";
import AttemptSummary from "./AttemptSummary";
import { clearLastUsername, loadLastUsername, saveLastUsername } from "@/lib/lastUsername";
import {
  loadCachedGameData,
  saveCachedGameData,
  isStale,
  type GameData as CachedGameDataShape,
} from "@/lib/gameDataCache";

 
import type { ParsedGame, FlaggedMove } from "@/types";
import type { OpponentFeatures } from "@/lib/lichess/opponentFeatures";

 

type GameData = CachedGameDataShape;
type IncomingGameData = Pick<GameData, "games"> &
  Partial<Pick<GameData, "flagged" | "warnings">>;

function isGameData(value: unknown): value is IncomingGameData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IncomingGameData>;
  return (
    Array.isArray(candidate.games) &&
    candidate.games.every(
      (game) =>
        !!game &&
        typeof game.id === "string" &&
        Array.isArray(game.moves) &&
        (game.playerColor === "white" || game.playerColor === "black")
    ) &&
    (candidate.flagged === undefined || Array.isArray(candidate.flagged)) &&
    (candidate.warnings === undefined ||
      (Array.isArray(candidate.warnings) &&
        candidate.warnings.every((warning) => typeof warning === "string")))
  );
}

function normalizeGameData(value: IncomingGameData): GameData {
  return {
    ...value,
    flagged: value.flagged ?? [],
    warnings: value.warnings ?? [],
  };
}

const SEVERITY_ORDER: Record<FlaggedMove["severity"], number> = { high: 0, medium: 1, low: 2 };

// how long Maia "thinks" before playing its move — matches the plan's 1-3s human-like delay
const MAIA_DELAY_MIN_MS = 1000;
const MAIA_DELAY_MAX_MS = 3000;

const NEUTRAL_OPPONENT_FEATURES: OpponentFeatures = {
  username: "",
  gamesAnalyzed: 0,
  mostCommonOpenings: [],
  queenTradeRate: 0.5,
  aggressionIndex: 0.35,
  avgRating: null,
  fetchedAt: Date.now(),
};

export default function GamePanel() {
  const [username, setUsername] = useState<string | null>(null);
  const [data, setData] = useState<GameData | null>(null);
  const [gameIdx, setGameIdx] = useState(0);
  const [ply, setPly] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flagAnalysisStatus, setFlagAnalysisStatus] = useState<string | null>(null);
  const [flagAnalysisError, setFlagAnalysisError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());


  const [dataFetchedAt, setDataFetchedAt] = useState<number | null>(null);
  const [attemptCount, setAttemptCount] = useState(0);
  const [initialUsernameChecked, setInitialUsernameChecked] = useState(false);
  const fetchRequestIdRef = useRef(0);



  // --- Step 10: replay state ---
  const [replay, setReplay] = useState(false);
  const [replayStatus, setReplayStatus] = useState<
    "idle" | "your-turn" | "maia-thinking" | "game-over"
  >("idle");
  const [replayResult, setReplayResult] = useState<string | null>(null); // e.g. "Checkmate — you win"
  const chessRef = useRef<Chess | null>(null); // the live, mutable replay game — separate from the read-only `fen` memo below
  const [replayFen, setReplayFen] = useState<string | undefined>();
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>();

   
  const [activeFlag, setActiveFlag] = useState<FlaggedMove | null>(null);
  const [replayFirstMoveSan, setReplayFirstMoveSan] = useState<string | null>(null);
  const [replayFirstMoveTimeSec, setReplayFirstMoveTimeSec] = useState<number | null>(null);
  const replayStartedAtRef = useRef<number | null>(null); // wall-clock ms when the board became interactive
  const attemptLoggedRef = useRef(false); // guards against double-logging if checkGameOver fires more than once






  const { infer } = useMaiaWorker();

  // --- Step 12: auto-load last-used username on mount, skipping the intake form ---
  useEffect(() => {
    const last = loadLastUsername();
    if (last) setUsername(last);
    setInitialUsernameChecked(true);
  }, []);

  useEffect(() => {
    if (!username) return;
    
    setDismissed(loadDismissed(username));
 
    setAttemptCount(loadAttempts(username).length);
    saveLastUsername(username);

    const cached = loadCachedGameData(username);
    if (cached && isGameData(cached) && Number.isFinite(cached.fetchedAt)) {
      const normalizedCache = normalizeGameData(cached);
      // Serve the cache immediately, no network call, no loading spinner —
      // this is the actual "skip the intake" behavior. isStale() just
      // controls whether we show a nudge to refresh, not whether we show
      // anything at all.
      setData(normalizedCache);
      setDataFetchedAt(cached.fetchedAt);
      setGameIdx(0);
      setPly(0);
      setLoadError(null);
      setLoading(false);
      if (isStale(cached)) fetchLive(username, false);
      return;
    }

    // No cache (first-ever visit for this username, or it was cleared) — fall
    // back to the original live-fetch path from Step 5.
    fetchLive(username);

  }, [username]);

  function fetchLive(forUsername: string, showLoading = true) {
    const requestId = ++fetchRequestIdRef.current;
    setLoadError(null);
    setLoading(showLoading);
    setRefreshing(!showLoading);

    void (async () => {
      try {
        const response = await fetch(
          `/api/games?username=${encodeURIComponent(forUsername)}`
        );
        const payload: unknown = await response.json();
        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload
              ? String(payload.error)
              : `Request failed (${response.status})`;
          throw new Error(message);
        }
        if (!isGameData(payload)) {
          throw new Error("The games API returned an invalid response.");
        }
        if (requestId !== fetchRequestIdRef.current) return;

        const normalizedData = normalizeGameData(payload);
        setData(normalizedData);
        saveCachedGameData(forUsername, normalizedData);
        const fetchedAt = Date.now();
        setDataFetchedAt(fetchedAt);
        setGameIdx(0);
        setPly(0);
      } catch (err) {
        if (requestId !== fetchRequestIdRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message);
        console.error("Failed to fetch games:", err);
      } finally {
        if (requestId === fetchRequestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
  }

  function refreshData() {
    if (!username) return;
    fetchLive(username, false);
  }

  function switchAccount() {
    fetchRequestIdRef.current++;
    clearLastUsername();
    setUsername(null);
    setData(null);
    setDataFetchedAt(null);
    setAttemptCount(0);
    setDismissed(new Set());
    setGameIdx(0);
    setPly(0);
    setLoading(false);
    setRefreshing(false);
    setLoadError(null);
    exitReplay();
  }


  const game = data?.games[gameIdx];

  const fen = useMemo(() => {
    if (!game) return undefined;
    const chess = new Chess();
    for (let i = 0; i < ply; i++) {
      const san = game.moves[i];
      if (!san) break;
      chess.move(san);
    }
    return chess.fen();
  }, [game, ply]);

  const flagsForGame = useMemo(
    () => data?.flagged.filter((f) => f.gameId === game?.id) ?? [],
    [data, game]
  );

  const visibleFlags = useMemo(() => {
    if (!data) return [];
    return [...data.flagged]
      .filter((f) => !dismissed.has(dismissalId(f.gameId, f.ply)))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [data, dismissed]);

  // Opponent features for whichever game is currently selected — needed by
  // rerankMoves() during replay. Loaded eagerly once a game is selected
  // (unlike VerdictCard's on-demand pattern from Step 8), since replay needs
  // it the instant the user makes their first move, not after a click.
  const { features: opponentFeatures, load: loadOpponentFeatures } = useOpponentFeatures();
  useEffect(() => {
    if (game?.opponentUsername) loadOpponentFeatures(game.opponentUsername);
  }, [game?.opponentUsername, loadOpponentFeatures]);

  useEffect(() => {
    if (!username || !data?.games.length) return;

    const games = data.games;
    let cancelled = false;
    const allMoveFeatures = extractAllMoveFeatures(games);
    const playerProfile = buildPlayerProfile(username, games, allMoveFeatures);
    setFlagAnalysisError(null);
    setFlagAnalysisStatus("Preparing game evaluations…");

    void (async () => {
      try {
        await runBackgroundEval(username, games, (progress) => {
          if (cancelled || progress.total === 0) return;
          setFlagAnalysisStatus(
            `Evaluating game ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          );
        });
        if (cancelled) return;

        setFlagAnalysisStatus("Generating flags…");
        const weaknessProfile = (await getProfile(username)) ?? emptyProfile(username);
        const flagged: FlaggedMove[] = [];

        for (const evaluatedGame of games) {
          const gameEval = await getCachedEval(evaluatedGame.id);
          if (!gameEval) continue;
          const gameFeatures = allMoveFeatures.filter((feature) => feature.gameId === evaluatedGame.id);
          flagged.push(
            ...flagMoves(
              gameFeatures,
              playerProfile,
              weaknessProfile,
              gameEval,
              evaluatedGame.playerColor
            )
          );
        }

        if (cancelled) return;
        flagged.sort((a, b) => b.cpLoss - a.cpLoss);
        setData((current) => {
          if (!current || current.games !== games) return current;
          const updated = { ...current, flagged };
          saveCachedGameData(username, updated);
          return updated;
        });
        setFlagAnalysisStatus(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setFlagAnalysisError(message);
        setFlagAnalysisStatus(null);
        console.error("Flag analysis failed:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [username, data?.games]);

  function jumpToFlag(flag: FlaggedMove) {
    if (!data) return;
    const idx = data.games.findIndex((g) => g.id === flag.gameId);
    if (idx === -1) return;
    setGameIdx(idx);
    setPly(flag.ply + 1);
    setReplay(false);
  }

  function dismissFlag(flag: FlaggedMove) {
    if (!username) return;
    const id = dismissalId(flag.gameId, flag.ply);
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(username, next);
  }

  function opponentLabelFor(flag: FlaggedMove): string | undefined {
    const g = data?.games.find((gm) => gm.id === flag.gameId);
    return g ? `vs ${g.opponentUsername}` : undefined;
  }

  // --- Step 10: start replay from a flagged move ---
  function retryReplay() {
     if (activeFlag) replayFromFlag(activeFlag);
  }

  function replayFromFlag(flag: FlaggedMove) {
    if (!data) return;
    const idx = data.games.findIndex((g) => g.id === flag.gameId);
    if (idx === -1) return;
    const g = data.games[idx];

    const chess = new Chess();
    for (let i = 0; i < flag.ply; i++) {
      const san = g.moves[i];
      if (!san) break;
      chess.move(san);
    }
    chessRef.current = chess;

    setGameIdx(idx);
    setReplay(true);
    setReplayResult(null);
    setLastMove(undefined);
    setReplayFen(chess.fen());

    setActiveFlag(flag);
    setReplayFirstMoveSan(null);
    setReplayFirstMoveTimeSec(null);
    attemptLoggedRef.current = false;

    // flag.ply is 0-indexed; whoever's turn it is at that ply is the user's turn
    // (the flag IS that move — the user gets a fresh shot at the same decision point)
    setReplayStatus("your-turn");
    replayStartedAtRef.current = Date.now();

    // If, after reconstructing the position, it's actually the opponent's turn
    // (shouldn't normally happen since a flagged move is always the user's own move,
    // but guarding anyway) kick off Maia immediately instead of waiting on a user click.
    if (chess.turn() !== (g.playerColor === "white" ? "w" : "b")) {
      runMaiaTurn(chess, g);
    }
  }

  function legalDests(chess: Chess): Map<Key, Key[]> {
    const dests = new Map<Key, Key[]>();
    for (const m of chess.moves({ verbose: true })) {
      const from = m.from as Key;
      const arr = dests.get(from) ?? [];
      arr.push(m.to as Key);
      dests.set(from, arr);
    }
    return dests;
  }


  const maiaTurnInProgress = useRef(false); // add this near your other useRef/useState declarations

  async function runMaiaTurn(chess: Chess, g: ParsedGame) {
    if (maiaTurnInProgress.current) return; // reject duplicate/overlapping calls
    maiaTurnInProgress.current = true;
    try {
      setReplayStatus("maia-thinking");

      const selfRating = g.playerColor === "white" ? g.opponentRating : g.playerRating;
      const oppRating = g.playerColor === "white" ? g.playerRating : g.opponentRating;

      const { logitsMaia } = await infer(chess.fen(), selfRating, oppRating);

      const result = await rerankMoves({
        fen: chess.fen(),
        logitsMaia,
        opponentFeatures: opponentFeatures ?? NEUTRAL_OPPONENT_FEATURES,
      });
      let uci: string | null = result.topMove?.uci ?? null;

      const delay = MAIA_DELAY_MIN_MS + Math.random() * (MAIA_DELAY_MAX_MS - MAIA_DELAY_MIN_MS);
      await new Promise((res) => setTimeout(res, delay));

      if (!uci) {
        checkGameOver(chess, g);
        return;
      }

      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci.slice(4) : undefined;

      const legal = chess.moves({ verbose: true }).some((m) => m.from === from && m.to === to);
      if (!legal) {
        console.error("Maia produced an illegal move, skipping it:", uci, "at fen", chess.fen());
        setReplayStatus("your-turn"); // don't leave the board stuck — let the user move again instead
        return;
      }

      chess.move({ from, to, promotion });

      setReplayFen(chess.fen());
      setLastMove([from as Key, to as Key]);

      if (!checkGameOver(chess, g)) {
        setReplayStatus("your-turn");
      }
    } catch (err) {
      console.error("runMaiaTurn failed:", err);
      setReplayStatus("your-turn");
    } finally {
      maiaTurnInProgress.current = false;
    }
  }


  function checkGameOver(chess: Chess, g: ParsedGame): boolean {
    if (!chess.isGameOver()) return false;
    setReplayStatus("game-over");
    const userIsWhite = g.playerColor === "white";
    const userToMove = chess.turn() === (userIsWhite ? "w" : "b");
    let outcome: string;
    if (chess.isCheckmate()) {
      // side to move is the one who got mated 
      outcome = userToMove ? "Checkmate — you were mated" : "Checkmate — you win";
    } else if (chess.isStalemate()) {
       
      outcome = "Stalemate — draw";
    } else if (chess.isDraw()) { 
      outcome = "Draw";
    } else { 
      outcome = "Game over";
    }
    setReplayResult(outcome);

    if (!attemptLoggedRef.current && username && activeFlag) {
       attemptLoggedRef.current = true;
       appendAttempt(username, {
         gameId: activeFlag.gameId,
         ply: activeFlag.ply,
         flagSan: activeFlag.san,
         flagTimeSpentSec: activeFlag.timeSpentSec,
         replaySan: replayFirstMoveSan,
         replayTimeSec: replayFirstMoveTimeSec,
         outcome,
         loggedAt: Date.now(),
       });
     }


    return true;
  }

  function handleUserMove(from: Key, to: Key) {
    const chess = chessRef.current;
    if (!chess || !game || replayStatus !== "your-turn") return;
    const moveResult = chess.move({ from, to, promotion: "q" }); // always auto-queen for now — underpromotion UI not in scope
    
    if (!moveResult) return; // illegal or malformed, Chessground shouldn't offer it anyway given dests

    if (replayFirstMoveSan === null) {
      setReplayFirstMoveSan(moveResult.san);
      const startedAt = replayStartedAtRef.current;
      setReplayFirstMoveTimeSec(startedAt ? (Date.now() - startedAt) / 1000 : null);
    }

    setReplayFen(chess.fen());
    setLastMove([from, to]);

    if (!checkGameOver(chess, game)) {
      runMaiaTurn(chess, game);
    }
    
  }
  

  function exitReplay() {
    setReplay(false);
    setReplayStatus("idle");
    setReplayResult(null);
    chessRef.current = null;
    setActiveFlag(null);
    setReplayFirstMoveSan(null);
    setReplayFirstMoveTimeSec(null);
    replayStartedAtRef.current = null;
  }

  
  if (!initialUsernameChecked) return null; // avoid a flash of the form before we've checked localStorage
  if (!username) return <UsernameForm onSubmit={setUsername} />;
  if (loading) {
    return (
      <div>
        Loading games… <button type="button" onClick={switchAccount}>Switch account</button>
      </div>
    );
  }

  if (!data || data.games.length === 0) {
    return (
      <div>
        {loadError ? `Could not load games: ${loadError}` : "No games found."}{" "}
        {loadError && <button type="button" onClick={() => fetchLive(username)}>Retry</button>}{" "}
        <button type="button" onClick={switchAccount}>Switch account</button>
      </div>
    );
  }

  const userColor = game?.playerColor;
  const liveChess = chessRef.current;
  const isInteractive = replay && replayStatus === "your-turn";

  return (
    <div style={{ display: "flex", gap: 24 }}>
      <div>
         <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
          {dataFetchedAt && (
            <span>
              {username} · last updated{" "}
              {Math.max(0, Math.round((Date.now() - dataFetchedAt) / 60000))}m ago
              {dataFetchedAt && isStale({ ...data, fetchedAt: dataFetchedAt })
                ? " (stale)"
                : ""}{" "}
              — <button type="button" onClick={refreshData} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>{" "}
              <button type="button" onClick={switchAccount}>Switch account</button>
            </span>
          )}
          {loadError && <span style={{ color: "#b00020", marginLeft: 8 }}>Refresh failed: {loadError}</span>}
          {flagAnalysisStatus && <span style={{ marginLeft: 8 }}>{flagAnalysisStatus}</span>}
          {flagAnalysisError && (
            <span style={{ color: "#b00020", marginLeft: 8 }}>
              Flag analysis failed: {flagAnalysisError}
            </span>
          )}
          {attemptCount > 0 && (
            <span style={{ marginLeft: 12 }}>
              You have {attemptCount} past attempt{attemptCount === 1 ? "" : "s"} logged.
            </span>
          )}
        </div>
        <select
          value={gameIdx}
          onChange={(e) => {
            setGameIdx(Number(e.target.value));
            setPly(0);
            exitReplay();
          }}
          disabled={replay}
        >
          {data.games.map((g, i) => (
            <option key={g.id} value={i}>
              {g.openingName} — vs {g.opponentUsername} ({g.result})
            </option>
          ))}
        </select>

        {replay && liveChess ? (
          <>
            <ChessgroundBoard
              fen={replayFen ?? liveChess.fen()}
              orientation={userColor}
              interactive={isInteractive}
              turnColor={liveChess.turn() === "w" ? "white" : "black"}
             
              dests={isInteractive ? legalDests(liveChess) : undefined}
              lastMove={lastMove}
              onUserMove={handleUserMove}
            />
            <div style={{ marginTop: 8 }}>
              <div>
                Status:{" "}
                {replayStatus === "your-turn" && "Your move"}
                {replayStatus === "maia-thinking" && "Maia is thinking…"} 
                {replayStatus === "game-over" && "Game over"}
              </div> 

              {replayStatus !== "game-over" && (
                 <button type="button" onClick={exitReplay}>Exit replay</button>
             )}

            </div>

            {replayStatus === "game-over" && activeFlag && (
              <AttemptSummary
                flag={activeFlag}
                replaySan={replayFirstMoveSan}
                replayTimeSec={replayFirstMoveTimeSec}
                outcome={replayResult ?? "Game over"}
                onRetry={retryReplay}
                onExit={exitReplay}
              />
            )}
          

          </>
        ) : (
          fen && <ChessgroundBoard fen={fen} />
        )}
      </div>

      <div style={{ maxHeight: 480, overflowY: "auto", minWidth: 280 }}>
        {data.warnings.length > 0 && (
          <div style={{ color: "orange", marginBottom: 8 }}>
            {data.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        <ol>
          {game?.moves.map((san, i) => {
            const moveNumber = Math.floor(i / 2) + 1;
            const flag = flagsForGame.find((f) => f.ply === i);
            return (
              <li
                key={i}
                onClick={() => {
                  setPly(i + 1);
                  exitReplay();
                }}
                style={{
                  cursor: "pointer",
                  background: flag
                    ? flag.severity === "high"
                      ? "#ffb3b3"
                      : flag.severity === "medium"
                      ? "#ffe0b3"
                      : "#fff6b3"
                    : "transparent",
                }}
              >
                {i % 2 === 0 ? `${moveNumber}. ` : ""}
                {san}
                {flag && <span style={{ marginLeft: 6, fontSize: 12 }}>⚠ {flag.severity}</span>}
              </li>
            );
          })}
        </ol>
      </div>

      <div style={{ minWidth: 260, maxHeight: 480, overflowY: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Flagged moves ({visibleFlags.length})</h3>
        {visibleFlags.length === 0 && <div>Nothing flagged (or everything dismissed).</div>}
        {visibleFlags.map((flag) => (
          <VerdictCard
            key={dismissalId(flag.gameId, flag.ply)}
            flag={flag}
            opponentLabel={opponentLabelFor(flag)}
            opponentUsername={data.games.find((g) => g.id === flag.gameId)?.opponentUsername}
            onJump={() => jumpToFlag(flag)}
            onDismiss={() => dismissFlag(flag)}
            onReplay={() => replayFromFlag(flag)}
          />
        ))}
      </div>
    </div>
  );
}