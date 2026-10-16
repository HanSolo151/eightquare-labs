"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";
import ChessgroundBoard from "./ChessgroundBoard";
import UsernameForm from "./UsernameForm";
import VerdictCard from "./VerdictCard";
import { dismissalId, isDismissed, loadDismissed, saveDismissed } from "@/lib/dismissals";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves, gamePhaseFromFen } from "@/lib/maia/rerank";
import type { RerankedMove } from "@/lib/maia/rerank";
import { useOpponentFeatures } from "@/lib/useOpponentFeatures";
import { eloToBucket } from "@/lib/maia/eloBuckets";
import { extractAllMoveFeatures, buildPlayerProfile } from "@/lib/features/extractFeatures";
import { flagMoves } from "@/lib/flags/flagEngine";
import { computePivotMove } from "@/lib/flags/pivotMove";
import { runBackgroundEval } from "@/lib/onboarding/backgroundEval";
import { getCachedEval, inspectGameEval } from "@/lib/eval/evalCache";
import { emptyProfile, getProfile } from "@/lib/profile/profileCache";
import { buildOpponentPieceActivityProfile } from "@/lib/profile/opponentPieceActivity";
import { buildOpponentOpeningTree } from "@/lib/profile/opponentOpeningTree";
import { buildOpponentTimePressureProfile } from "@/lib/profile/opponentTimePressure";
import { LichessFetchError } from "@/lib/lichess/fetchGames";
import { emptyPieceActivityProfile, updatePieceActivityProfile } from "@/lib/profile/pieceActivityProfile";
import { getPieceActivityProfile, savePieceActivityProfile } from "@/lib/profile/pieceActivityProfileCache";
import type { PieceActivityProfile, OpeningTree, OpponentTimePressureProfile, GamePhase } from "@/types";
 

import { appendAttempt, loadAttempts } from "@/lib/attemptLog";
import AttemptSummary from "./AttemptSummary";
import { clearLastUsername, loadLastUsername, saveLastUsername } from "@/lib/lastUsername";
import {
  loadCachedGameData,
  saveCachedGameData,
  isStale,
  type GameData as CachedGameDataShape,
} from "@/lib/gameDataCache";

 
import type { ParsedGame, FlaggedMove, PivotMoveAttribution } from "@/types";
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
const MAIA_INFER_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Maia inference timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function maiaRatingsFor(g: ParsedGame): { selfRating: number | null; oppRating: number | null } {
  return { selfRating: g.opponentRating, oppRating: g.playerRating };
}

function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function tryPlayUci(chess: Chess, uci: string): boolean {
  try {
    return !!chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4) : undefined,
    });
  } catch {
    return false;
  }
}

function weightedSample(moves: RerankedMove[]): RerankedMove | null {
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
    "idle" | "your-turn" | "maia-thinking" | "maia-error" | "game-over"
  >("idle");
  const [replayResult, setReplayResult] = useState<string | null>(null); // e.g. "Checkmate — you win"
  const chessRef = useRef<Chess | null>(null); // the live, mutable replay game — separate from the read-only `fen` memo below
  const [replayFen, setReplayFen] = useState<string | undefined>();
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>();

   
  const [activeFlag, setActiveFlag] = useState<FlaggedMove | null>(null);
  const [opponentPieceActivityProfile, setOpponentPieceActivityProfile] = useState<PieceActivityProfile | null>(null);
  const [opponentOpeningTree, setOpponentOpeningTree] = useState<OpeningTree | null>(null);
  const [opponentTimePressureProfile, setOpponentTimePressureProfile] = useState<OpponentTimePressureProfile | null>(null);
  const [replayFirstMoveSan, setReplayFirstMoveSan] = useState<string | null>(null);
  const [replayFirstMoveTimeSec, setReplayFirstMoveTimeSec] = useState<number | null>(null);
  const replaySessionRef = useRef(0);
  const maiaTurnSessionRef = useRef<number | null>(null);
  const attemptRef = useRef<{ flag: FlaggedMove | null; firstSan: string | null; firstTimeSec: number | null }>({
    flag: null,
    firstSan: null,
    firstTimeSec: null,
  });
  const replayStartedAtRef = useRef<number | null>(null); // wall-clock ms when the board became interactive
  const attemptLoggedRef = useRef(false); // guards against double-logging if checkGameOver fires more than once
  const pivotMoveCache = useRef(new Map<string, PivotMoveAttribution | null>());
  const pivotMoveLoads = useRef(new Map<string, Promise<void>>());
  // Step 3: same cache backs both the replay inline display (activeFlag.pivotMove)
  // and VerdictCard's on-demand pivot section (pivotByKey, looked up by any
  // flag, list or active). One in-flight fetch per key either way.
  const [pivotByKey, setPivotByKey] = useState<Record<string, PivotMoveAttribution | null>>({});
  const [pivotStatusByKey, setPivotStatusByKey] = useState<Record<string, "loading" | "unavailable">>({});
  const pivotKey = (flag: Pick<FlaggedMove, "gameId" | "ply">) => `${flag.gameId}:${flag.ply}`;

  function mergePivotIntoActiveFlag(flag: FlaggedMove, pivotMove: PivotMoveAttribution) {
    setActiveFlag((prev) => prev && prev.gameId === flag.gameId && prev.ply === flag.ply
      ? { ...prev, pivotMove }
      : prev);
  }

  function loadPivotMove(flag: FlaggedMove, g: ParsedGame) {
    const key = pivotKey(flag);
    if (pivotMoveCache.current.has(key)) {
      const cached = pivotMoveCache.current.get(key) ?? null;
      setPivotByKey((prev) => key in prev ? prev : { ...prev, [key]: cached });
      setPivotStatusByKey((prev) => ({ ...prev, [key]: "unavailable" }));
      if (cached) {
        setPivotStatusByKey((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      if (cached) mergePivotIntoActiveFlag(flag, cached);
      return;
    }
    if (pivotMoveLoads.current.has(key)) return;
    if (flag.ply < 1) {
      pivotMoveCache.current.set(key, null);
      setPivotByKey((prev) => ({ ...prev, [key]: null }));
      setPivotStatusByKey((prev) => ({ ...prev, [key]: "unavailable" }));
      return;
    }
    const pivotPly = flag.ply - 1;
    const positionBeforePivot = new Chess();
    for (let i = 0; i < pivotPly; i++) {
      const san = g.moves[i];
      if (!san) break;
      positionBeforePivot.move(san);
    }
    const pivotSan = g.moves[pivotPly];
    if (!pivotSan) {
      pivotMoveCache.current.set(key, null);
      setPivotByKey((prev) => ({ ...prev, [key]: null }));
      setPivotStatusByKey((prev) => ({ ...prev, [key]: "unavailable" }));
      return;
    }
    setPivotStatusByKey((prev) => ({ ...prev, [key]: "loading" }));
    const load = computePivotMove(positionBeforePivot, pivotPly, pivotSan)
      .then((result) => {
        pivotMoveCache.current.set(key, result);
        setPivotByKey((prev) => ({ ...prev, [key]: result }));
        setPivotStatusByKey((prev) => {
          if (result) {
            const next = { ...prev };
            delete next[key];
            return next;
          }
          return { ...prev, [key]: "unavailable" };
        });
        if (result) mergePivotIntoActiveFlag(flag, result);
      })
      .catch((err) => {
        console.error("Pivot-move attribution failed:", err);
        pivotMoveCache.current.set(key, null);
        setPivotByKey((prev) => ({ ...prev, [key]: null }));
        setPivotStatusByKey((prev) => ({ ...prev, [key]: "unavailable" }));
      })
      .finally(() => {
        pivotMoveLoads.current.delete(key);
      });
    pivotMoveLoads.current.set(key, load);
  }

  // Step 3: VerdictCard-driven loader for the flagged-moves list. Distinct
  // entry point from replayFromFlag's loadPivotMove call — this one resolves
  // the ParsedGame from `data` (replay already has `g` in hand), and is only
  // invoked when a card is expanded, not for every visible flag up front:
  // computePivotMove runs a real multiPV Stockfish search per call, and the
  // list can hold many flags, so eager-loading all of them was rejected as
  // needlessly expensive for a feature that's opt-in per card.
  function loadPivotForListFlag(flag: FlaggedMove) {
    const key = pivotKey(flag);
    if (key in pivotByKey || pivotMoveLoads.current.has(key)) return;
    const g = data?.games.find((game) => game.id === flag.gameId);
    if (!g) return;
    loadPivotMove(flag, g);
  }






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
      .filter((f) => !isDismissed(dismissed, f.gameId, f.ply, f.flagType))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [data, dismissed]);

  // Opponent features for whichever game is currently selected — needed by
  // rerankMoves() during replay. Loaded eagerly once a game is selected
  // (unlike VerdictCard's on-demand pattern from Step 8), since replay needs
  // it the instant the user makes their first move, not after a click.
  const { features: opponentFeatures, load: loadOpponentFeatures } = useOpponentFeatures();
  useEffect(() => {
    const opponentName = game?.opponentUsername;
    if (!opponentName || opponentName.toLowerCase() === "anonymous") return;
    let cancelled = false;

    setOpponentPieceActivityProfile(null);
    setOpponentOpeningTree(null);
    setOpponentTimePressureProfile(null);

    // Lichess asks clients to make one API request at a time. These loaders
    // each need the same recent game list, so keep the requests sequential;
    // fetchGames coalesces/caches matching requests across the profile builds.
    void (async () => {
      await loadOpponentFeatures(opponentName);
      if (cancelled) return;

      try {
        const profile = await buildOpponentPieceActivityProfile(opponentName);
        if (cancelled) return;
        setOpponentPieceActivityProfile(profile);
        console.info("Opponent piece-activity profile updated", {
          opponent: opponentName,
          gamesEvaluated: profile.gamesEvaluated,
          confidence: profile.confidence,
        });
      } catch (err) {
        if (err instanceof LichessFetchError && err.isNotFound) {
          console.info("Opponent account no longer exists on Lichess:", opponentName);
        } else {
          console.error("Opponent piece-activity profile build failed:", err);
        }
      }
      if (cancelled) return;

      try {
        const tree = await buildOpponentOpeningTree(opponentName);
        if (cancelled) return;
        setOpponentOpeningTree(tree);
        console.info("Opponent opening tree updated", {
          opponent: opponentName,
          gamesEvaluated: tree.gamesEvaluated,
          positionsSeen: Object.keys(tree.positions).length,
        });
      } catch (err) {
        if (err instanceof LichessFetchError && err.isNotFound) {
          console.info("Opponent account no longer exists on Lichess:", opponentName);
        } else {
          console.error("Opponent opening-tree build failed:", err);
        }
      }
      if (cancelled) return;

      try {
        const timePressure = await buildOpponentTimePressureProfile(opponentName);
        if (cancelled) return;
        setOpponentTimePressureProfile(timePressure);
        console.info("Opponent time-pressure profile updated", {
          opponent: opponentName,
          gamesAnalyzed: timePressure.gamesAnalyzed,
          byPhase: timePressure.byPhase,
        });
      } catch (err) {
        if (err instanceof LichessFetchError && err.isNotFound) {
          console.info("Opponent account no longer exists on Lichess:", opponentName);
        } else {
          console.error("Opponent time-pressure profile build failed:", err);
        }
      }
    })().catch((err) => {
      console.error("Opponent feature load failed:", err);
    });

    return () => {
      cancelled = true;
    };
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
        const pieceActivityProfile =
          (await getPieceActivityProfile(username)) ?? emptyPieceActivityProfile(username);
        const flagged: FlaggedMove[] = [];
        const evalQualityIssues: ReturnType<typeof inspectGameEval>[] = [];
        let expectedPlies = 0;
        let cpComparablePlies = 0;
        let mateOnlyPlies = 0;
        let unscoredPlies = 0;
        const moveFeatureCoverageIssues: { gameId: string; parsedMoves: number; features: number }[] = [];

        for (const evaluatedGame of games) {
          const gameEval = await getCachedEval(evaluatedGame.id, evaluatedGame.moves.length);
          if (!gameEval) {
            evalQualityIssues.push({
              gameId: evaluatedGame.id,
              expectedPlyCount: evaluatedGame.moves.length,
              actualPointCount: 0,
              missingPlies: Array.from({ length: evaluatedGame.moves.length }, (_, ply) => ply),
              duplicatePlies: [], invalidPlies: [], extraPlies: [], invalidScorePlies: [],
              invalidDepthPlies: [], mateOnlyPlies: [], cpComparablePlies: [],
              structurallyComplete: false,
            });
            expectedPlies += evaluatedGame.moves.length;
            unscoredPlies += evaluatedGame.moves.length;
            continue;
          }
          const quality = inspectGameEval(gameEval, evaluatedGame.moves.length);
          expectedPlies += quality.expectedPlyCount;
          cpComparablePlies += quality.cpComparablePlies.length;
          mateOnlyPlies += quality.mateOnlyPlies.length;
          unscoredPlies += quality.invalidScorePlies.length;
          if (
            !quality.structurallyComplete || quality.invalidScorePlies.length > 0 ||
            quality.invalidDepthPlies.length > 0 || quality.mateOnlyPlies.length > 0
          ) {
            evalQualityIssues.push(quality);
          }
          const gameFeatures = allMoveFeatures.filter((feature) => feature.gameId === evaluatedGame.id);
          if (gameFeatures.length !== evaluatedGame.moves.length) {
            moveFeatureCoverageIssues.push({
              gameId: evaluatedGame.id,
              parsedMoves: evaluatedGame.moves.length,
              features: gameFeatures.length,
            });
          }
          flagged.push(
            ...flagMoves(
              gameFeatures,
              playerProfile,
              weaknessProfile,
              gameEval,
              evaluatedGame.playerColor
            )
          );
          updatePieceActivityProfile(
            pieceActivityProfile,
            evaluatedGame.id,
            evaluatedGame.moves,
            gameEval,
            gameFeatures,
            evaluatedGame.playerColor
          );
        }

        await savePieceActivityProfile(pieceActivityProfile);
        console.info("Piece-activity profile updated", {
          username,
          gamesEvaluated: pieceActivityProfile.gamesEvaluated,
          confidence: pieceActivityProfile.confidence,
        });

        console.info("Flagging evaluation coverage", {
          username,
          games: games.length,
          expectedPlies,
          cpComparablePlies,
          cpComparableRate: expectedPlies > 0 ? Number((cpComparablePlies / expectedPlies).toFixed(4)) : 0,
          mateOnlyPlies,
          unscoredPlies,
          moveFeatureCoverageIssues: moveFeatureCoverageIssues.length,
          flaggedMoves: flagged.length,
        });
        if (evalQualityIssues.length > 0) {
          console.warn("Flagging skipped or encountered incomplete evaluation data", evalQualityIssues);
        }
        if (moveFeatureCoverageIssues.length > 0) {
          console.warn("Parsed moves missing extracted move features", moveFeatureCoverageIssues);
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
    const id = dismissalId(flag.gameId, flag.ply, flag.flagType);
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

    replaySessionRef.current += 1;
    attemptRef.current = { flag, firstSan: null, firstTimeSec: null };
    setActiveFlag(flag);
    setReplayFirstMoveSan(null);
    setReplayFirstMoveTimeSec(null);
    attemptLoggedRef.current = false;
    loadPivotMove(flag, g);

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


  async function runMaiaTurn(chess: Chess, g: ParsedGame) {
    const session = replaySessionRef.current;
    if (maiaTurnSessionRef.current === session) return;
    maiaTurnSessionRef.current = session;
    const stale = () => replaySessionRef.current !== session;

    try {
      setReplayStatus("maia-thinking");

      const { selfRating, oppRating } = maiaRatingsFor(g);
      const inferenceFen = chess.fen();
      const { logitsMaia } = await withTimeout(infer(inferenceFen, selfRating, oppRating), MAIA_INFER_TIMEOUT_MS);
      if (stale()) return;

      const matchingOpponentFeatures = sameUser(opponentFeatures?.username, g.opponentUsername)
        ? opponentFeatures!
        : NEUTRAL_OPPONENT_FEATURES;
      const pieceActivityProfile = sameUser(opponentPieceActivityProfile?.username, g.opponentUsername)
        ? opponentPieceActivityProfile
        : null;
      const openingTree = sameUser(opponentOpeningTree?.username, g.opponentUsername)
        ? opponentOpeningTree
        : null;
      const timePressureProfile = sameUser(opponentTimePressureProfile?.username, g.opponentUsername)
        ? opponentTimePressureProfile
        : null;
      const currentPhase: GamePhase = gamePhaseFromFen(new Chess(inferenceFen));
      const phaseBucket = timePressureProfile?.byPhase[currentPhase] ?? null;
      const collapsing = !!phaseBucket && phaseBucket.confidence !== "low" &&
        Math.random() < phaseBucket.collapseRate;

      const result = await rerankMoves({
        fen: inferenceFen,
        logitsMaia,
        opponentFeatures: matchingOpponentFeatures,
        pieceActivityProfile,
        openingTree,
      });
      if (stale()) return;

      console.info("Maia replay choice", {
        gameId: g.id,
        playerColor: g.playerColor,
        maiaColor: g.playerColor === "white" ? "black" : "white",
        selfRating,
        oppRating,
        usedPieceActivityProfile: !!pieceActivityProfile,
        usedOpeningTree: !!openingTree,
        currentPhase,
        collapsing,
        phaseAvgSec: phaseBucket?.phaseAvgSec ?? null,
        collapseRate: phaseBucket?.collapseRate ?? null,
        baseTopMove: result.baseTopMove?.uci,
        adjustedTopMove: result.topMove?.uci,
        safetyChecked: result.safetyChecked,
        safetyDowngraded: result.safetyDowngraded,
      });

      let delay: number;
      if (collapsing) {
        delay = MAIA_DELAY_MIN_MS * 0.3 + Math.random() * (MAIA_DELAY_MIN_MS * 0.4);
      } else if (phaseBucket?.phaseAvgSec) {
        const avgMs = phaseBucket.phaseAvgSec * 1000;
        delay = Math.min(MAIA_DELAY_MAX_MS * 3, Math.max(MAIA_DELAY_MIN_MS, avgMs));
      } else {
        delay = MAIA_DELAY_MIN_MS + Math.random() * (MAIA_DELAY_MAX_MS - MAIA_DELAY_MIN_MS);
      }
      await new Promise((res) => setTimeout(res, delay));
      if (stale()) return;

      let playedUci: string | null = null;
      if (collapsing) {
        const sampled = weightedSample(result.moves);
        if (sampled && tryPlayUci(chess, sampled.uci)) playedUci = sampled.uci;
      }
      const candidates = [result.topMove?.uci, result.baseTopMove?.uci, ...result.moves.map((move) => move.uci)]
        .filter((uci): uci is string => !!uci);
      for (const uci of candidates) {
        if (playedUci) break;
        if (tryPlayUci(chess, uci)) {
          playedUci = uci;
          break;
        }
        console.error("Maia candidate rejected by chess.js:", uci, "at fen", chess.fen());
      }

      if (!playedUci) {
        if (!checkGameOver(chess, g)) setReplayStatus("maia-error");
        return;
      }

      if (playedUci !== (result.topMove?.uci ?? result.baseTopMove?.uci)) {
        console.info("Maia played a different move than ranked (collapse or fallback)", {
          gameId: g.id,
          playedUci,
          collapsing,
          rankedTopMove: result.topMove?.uci ?? null,
        });
      }

      setReplayFen(chess.fen());
      setLastMove([playedUci.slice(0, 2) as Key, playedUci.slice(2, 4) as Key]);

      if (!checkGameOver(chess, g)) {
        setReplayStatus("your-turn");
      }
    } catch (err) {
      console.error("runMaiaTurn failed:", err);
      if (!stale()) setReplayStatus("maia-error");
    } finally {
      if (maiaTurnSessionRef.current === session) maiaTurnSessionRef.current = null;
    }
  }

  function retryMaiaTurn() {
    const chess = chessRef.current;
    if (!chess || !game) return;
    runMaiaTurn(chess, game);
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
    } else if (chess.isThreefoldRepetition()) {
      outcome = "Draw — threefold repetition";
    } else if (chess.isInsufficientMaterial()) {
      outcome = "Draw — insufficient material";
    } else if (chess.isDraw()) {
      outcome = "Draw — 50-move rule";
    } else {
      outcome = "Game over";
    }
    setReplayResult(outcome);

    const { flag, firstSan, firstTimeSec } = attemptRef.current;
    if (!attemptLoggedRef.current && username && flag) {
       attemptLoggedRef.current = true;
       appendAttempt(username, {
         gameId: flag.gameId,
         ply: flag.ply,
         flagSan: flag.san,
         flagTimeSpentSec: flag.timeSpentSec,
         replaySan: firstSan,
         replayTimeSec: firstTimeSec,
         outcome,
         loggedAt: Date.now(),
       });
       setAttemptCount(loadAttempts(username).length);
     }


    return true;
  }

  function handleUserMove(from: Key, to: Key) {
    const chess = chessRef.current;
    if (!chess || !game || replayStatus !== "your-turn") return;
    let moveResult;
    try {
      moveResult = chess.move({ from, to, promotion: "q" }); // always auto-queen for now — underpromotion UI not in scope
    } catch {
      return;
    }
    if (!moveResult) return; // illegal or malformed, Chessground shouldn't offer it anyway given dests

    if (attemptRef.current.firstSan === null) {
      const startedAt = replayStartedAtRef.current;
      const timeSec = startedAt ? (Date.now() - startedAt) / 1000 : null;
      attemptRef.current = { ...attemptRef.current, firstSan: moveResult.san, firstTimeSec: timeSec };
      setReplayFirstMoveSan(moveResult.san);
      setReplayFirstMoveTimeSec(timeSec);
    }

    setReplayFen(chess.fen());
    setLastMove([from, to]);

    if (!checkGameOver(chess, game)) {
      runMaiaTurn(chess, game);
    }
    
  }
  

  function exitReplay() {
    replaySessionRef.current += 1;
    maiaTurnSessionRef.current = null;
    attemptRef.current = { flag: null, firstSan: null, firstTimeSec: null };
    setReplay(false);
    setReplayStatus("idle");
    setReplayResult(null);
    setReplayFen(undefined);
    setLastMove(undefined);
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
                {replayStatus === "maia-error" && (
                  <>
                    Maia couldn't produce a move.{" "}
                    <button type="button" onClick={retryMaiaTurn}>Retry Maia&apos;s move</button>
                  </>
                )}
                {replayStatus === "game-over" && "Game over"}
              </div> 

              {replayStatus !== "game-over" && (
                 <button type="button" onClick={exitReplay}>Exit replay</button>
             )}

            </div>

            {/* Reserved for Phase 3: pivot-move context (activeFlag.pivotMove),
                shown while replay is in progress, not just at game-over. Null
                until Phase 3's attribution logic exists — render nothing until then. */}
            {activeFlag?.pivotMove && (
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                Pivot: {activeFlag.pivotMove.san} (ply {activeFlag.pivotMove.ply})
              </div>
            )}

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
            key={dismissalId(flag.gameId, flag.ply, flag.flagType)}
            flag={flag}
            opponentLabel={opponentLabelFor(flag)}
            opponentUsername={data.games.find((g) => g.id === flag.gameId)?.opponentUsername}
            onJump={() => jumpToFlag(flag)}
            onDismiss={() => dismissFlag(flag)}
            onReplay={() => replayFromFlag(flag)}
            pivotMove={flag.pivotMove ?? pivotByKey[pivotKey(flag)] ?? null}
            pivotLoading={pivotStatusByKey[pivotKey(flag)] === "loading"}
            onLoadPivot={() => loadPivotForListFlag(flag)}
          />
        ))}
      </div>
    </div>
  );
}
