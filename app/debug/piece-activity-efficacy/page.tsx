"use client";

import { useState } from "react";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { evalGame } from "@/lib/eval/evalCache";
import { extractMoveFeatures } from "@/lib/features/extractFeatures";
import {
  emptyPieceActivityProfile,
  updatePieceActivityProfile,
} from "@/lib/profile/pieceActivityProfile";
import type { PieceActivityProfile, PieceType, ParsedGame } from "@/types";

const PIECE_TYPES: PieceType[] = ["p", "n", "b", "r", "q", "k"];
const PHASES = ["opening", "middlegame", "endgame"] as const;

/**
 * Two components per piece type and phase, each normalized within its phase:
 * phase move share and deviation from the engine's piece-type choice.
 */
function toRateVector(profile: PieceActivityProfile): number[] {
  return PHASES.flatMap((phase) => {
    const phaseTotal = PIECE_TYPES.reduce(
      (sum, piece) => sum + profile.byPieceType[piece][phase].moveCount,
      0
    );
    return PIECE_TYPES.flatMap((piece) => {
      const bucket = profile.byPieceType[piece][phase];
      const shareOfPhase = phaseTotal > 0 ? bucket.moveCount / phaseTotal : 0;
      const deviationFromEngine = bucket.moveCount > 0
        ? 1 - bucket.engineTopMatchCount / bucket.moveCount
        : 0;
      return [shareOfPhase, deviationFromEngine];
    });
  });
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denominatorA += da * da;
    denominatorB += db * db;
  }
  const denominator = Math.sqrt(denominatorA * denominatorB);
  return denominator === 0 ? 0 : numerator / denominator;
}

async function buildProfileForGames(
  label: string,
  games: ParsedGame[],
  log: (line: string) => void
): Promise<PieceActivityProfile> {
  const profile = emptyPieceActivityProfile(label);
  let skipped = 0;
  let done = 0;
  let nextIndex = 0;
  const started = Date.now();
  const CONCURRENCY = 2;

  async function worker() {
    while (nextIndex < games.length) {
      const game = games[nextIndex++];
      try {
        const gameEval = await evalGame(game.id, game.moves);
        const moveFeatures = extractMoveFeatures(game);
        // Aggregation mutates the profile synchronously after each eval
        // resolves, so workers don't interleave updates to the shared object.
        updatePieceActivityProfile(profile, game.id, game.moves, gameEval, moveFeatures, game.playerColor);
      } catch (err) {
        skipped++;
        log(`  (skipping ${game.id}: ${err instanceof Error ? err.message : String(err)})`);
      }
      done++;
      const elapsedSec = ((Date.now() - started) / 1000).toFixed(0);
      log(`  [${label}] ${done}/${games.length} games done (${elapsedSec}s elapsed)`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (skipped > 0) log(`  ${skipped}/${games.length} games skipped for ${label}`);
  return profile;
}

export default function PieceActivityEfficacyPage() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  async function runSplitHalf(username: string) {
    setRunning(true);
    setLog([]);
    const append = (line: string) => setLog((previous) => [...previous, line]);
    try {
      append(`Split-half reliability for ${username}`);
      const raw = await fetchGames({ username, max: 40, rated: true, perfType: "rapid" });
      const games = parseGames(raw, username);
      if (games.length < 10) {
        append(`Not enough games (${games.length}) for a meaningful split.`);
        return;
      }
      const half = Math.floor(games.length / 2);
      append(`Building profile A (${half} games)...`);
      const profileA = await buildProfileForGames(`${username}-A`, games.slice(0, half), append);
      append(`Building profile B (${games.length - half} games)...`);
      const profileB = await buildProfileForGames(`${username}-B`, games.slice(half), append);
      const correlation = pearsonCorrelation(toRateVector(profileA), toRateVector(profileB));
      append(`Pearson r = ${correlation.toFixed(3)}`);
      append(
        correlation > 0.7 ? "→ Strong, looks like a real stable signal." :
        correlation > 0.4 ? "→ Moderate — some signal, noisy at this sample size." :
        "→ Weak — mostly noise at this sample size."
      );
    } catch (err) {
      append(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  async function runCompare(userA: string, userB: string) {
    setRunning(true);
    setLog([]);
    const append = (line: string) => setLog((previous) => [...previous, line]);
    try {
      append(`Distinctiveness: ${userA} vs ${userB}`);
      const [rawA, rawB] = await Promise.all([
        fetchGames({ username: userA, max: 30, rated: true, perfType: "rapid" }),
        fetchGames({ username: userB, max: 30, rated: true, perfType: "rapid" }),
      ]);
      const gamesA = parseGames(rawA, userA);
      const gamesB = parseGames(rawB, userB);
      append(`Building profile for ${userA} (${gamesA.length} games)...`);
      const profileA = await buildProfileForGames(userA, gamesA, append);
      append(`Building profile for ${userB} (${gamesB.length} games)...`);
      const profileB = await buildProfileForGames(userB, gamesB, append);
      const correlation = pearsonCorrelation(toRateVector(profileA), toRateVector(profileB));
      append(`Pearson r (cross-player) = ${correlation.toFixed(3)}`);
      append("Compare against split-half r for either player — close/higher means the signal isn't distinguishing style from noise.");
    } catch (err) {
      append(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h2>Piece-activity efficacy (dev only)</h2>
      <button disabled={running} onClick={() => void runSplitHalf("Maverick151")}>
        Split-half: Maverick151
      </button>{" "}
      <button disabled={running} onClick={() => void runCompare("Maverick151", "brino")}>
        Compare: Maverick151 vs brino
      </button>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}
