"use client";

import { useState } from "react";
import { Chess } from "chess.js";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { extractOpponentFeatures, type OpponentFeatures } from "@/lib/lichess/opponentFeatures";
import { useMaiaWorker } from "@/lib/maia/useMaiaWorker";
import { rerankMoves } from "@/lib/maia/rerank";
import { buildOpponentPieceActivityProfile } from "@/lib/profile/opponentPieceActivity";
import type { ParsedGame, PieceType } from "@/types";

const NEUTRAL_FEATURES: OpponentFeatures = {
  username: "",
  gamesAnalyzed: 0,
  mostCommonOpenings: [],
  queenTradeRate: 0.5,
  aggressionIndex: 0.35,
  avgRating: null,
  fetchedAt: Date.now(),
};

function pieceTypeFromUci(fen: string, uci: string): PieceType | null {
  const chess = new Chess(fen);
  const piece = chess.get(uci.slice(0, 2) as Parameters<Chess["get"]>[0]);
  return piece?.type ?? null;
}

function pieceTypeFromSan(san: string): PieceType {
  switch (san[0]) {
    case "O": return "k";
    case "N": return "n";
    case "B": return "b";
    case "R": return "r";
    case "Q": return "q";
    case "K": return "k";
    default: return "p";
  }
}

const HELD_OUT_COUNT = 25;
const BUILD_SET_COUNT = 40;
type Phase = "opening" | "middlegame" | "endgame";
const PHASES: Phase[] = ["opening", "middlegame", "endgame"];
const DEFAULT_OPPONENTS = [
  "makarvlch",
  "PARSA-2-0-1-0",
  "racketsaber",
  "Levofloxacine",
  "Dani001187",
  "vadimpindos14",
  "dageamMister",
  "oprokhorov",
  "BugritGambit",
  "Ezio545",
  "GamarraGhost",
  "chessugu1981",
  "Danger888",
  "ded2n2",
  "meyviriofrio",
  "Gambler123I",
  "jayCarlsen",
  "akenpalihawadana",
  "Zideha",
  "antbev",
  "Msayed0",
  "mahardikaaa",
  "D4813l",
  "baris828",
].join("\n");
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function gamePhaseAt(chess: Chess): Phase {
  let material = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (square) material += PIECE_VALUES[square.type] ?? 0;
    }
  }
  if (material / 78 <= 0.5) return "endgame";
  const fullmove = Number.parseInt(chess.fen().split(" ")[5] ?? "1", 10) || 1;
  return fullmove <= 12 ? "opening" : "middlegame";
}

export default function MaiaMimicryEfficacyPage() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [usernamesInput, setUsernamesInput] = useState(DEFAULT_OPPONENTS);
  const { infer } = useMaiaWorker();
  const append = (line: string) => setLog((previous) => [...previous, line]);

  async function runOne(opponentUsername: string): Promise<Record<Phase, { baselineMatches: number; rerankedMatches: number; total: number }>> {
    const byPhase: Record<Phase, { baselineMatches: number; rerankedMatches: number; total: number }> = {
      opening: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
      middlegame: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
      endgame: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
    };
    append(`Held-out mimicry test for ${opponentUsername}`);
    const raw = await fetchGames({
      username: opponentUsername,
      max: BUILD_SET_COUNT + HELD_OUT_COUNT,
      rated: true,
      perfType: "rapid",
    });
    const allGames = parseGames(raw, opponentUsername);
    if (allGames.length < BUILD_SET_COUNT + 5) {
      append(`Not enough games (${allGames.length}) for a clean build/held-out split.`);
      return byPhase;
    }

    const buildGames = allGames.slice(0, BUILD_SET_COUNT);
    const heldOutGames = allGames.slice(BUILD_SET_COUNT, BUILD_SET_COUNT + HELD_OUT_COUNT);
    append(`Build set: ${buildGames.length} games — held-out: ${heldOutGames.length} games`);
    append("Building OpponentFeatures from build set only...");

    const opponentFeatures = await extractOpponentFeatures(opponentUsername, BUILD_SET_COUNT);
    append("Building piece-activity profile from build set...");
    const pieceActivityProfile = await buildOpponentPieceActivityProfile(opponentUsername);

    for (const game of heldOutGames) {
      const chess = new Chess();
      const opponentColor = game.playerColor;
      for (let ply = 0; ply < game.moves.length; ply++) {
        const san = game.moves[ply];
        const moverColor = ply % 2 === 0 ? "white" : "black";
        const fenBeforeMove = chess.fen();
        let moveResult;
        try { moveResult = chess.move(san); } catch { break; }
        if (!moveResult) break;
        if (moverColor !== opponentColor) continue;

        const phase = gamePhaseAt(chess);
        const bucket = byPhase[phase];
        bucket.total++;
        const actualPieceType = pieceTypeFromSan(san);
        try {
          const { logitsMaia } = await infer(fenBeforeMove, game.playerRating, game.opponentRating);
          const baseline = await rerankMoves({ fen: fenBeforeMove, logitsMaia, opponentFeatures: NEUTRAL_FEATURES });
          const reranked = await rerankMoves({ fen: fenBeforeMove, logitsMaia, opponentFeatures, pieceActivityProfile });
          const baselineUci = baseline.baseTopMove?.uci ?? null;
          const rerankedUci = reranked.topMove?.uci ?? reranked.baseTopMove?.uci ?? null;
          if (baselineUci && pieceTypeFromUci(fenBeforeMove, baselineUci) === actualPieceType) bucket.baselineMatches++;
          if (rerankedUci && pieceTypeFromUci(fenBeforeMove, rerankedUci) === actualPieceType) bucket.rerankedMatches++;
        } catch (err) {
          append(`  (skipping ply ${ply} of ${game.id}: ${err instanceof Error ? err.message : String(err)})`);
          bucket.total--;
        }
      }
      const grandTotal = PHASES.reduce((sum, phase) => sum + byPhase[phase].total, 0);
      append(`  ${game.id} done — ${grandTotal} positions so far`);
    }

    append(`\n=== ${opponentUsername}: per-phase breakdown ===`);
    let overallBaseline = 0;
    let overallReranked = 0;
    let overallTotal = 0;
    for (const phase of PHASES) {
      const bucket = byPhase[phase];
      overallBaseline += bucket.baselineMatches;
      overallReranked += bucket.rerankedMatches;
      overallTotal += bucket.total;
      if (bucket.total === 0) {
        append(`${phase}: 0 positions — skipped`);
        continue;
      }
      const baselineRate = bucket.baselineMatches / bucket.total;
      const rerankedRate = bucket.rerankedMatches / bucket.total;
      append(`${phase}: n=${bucket.total}  baseline=${(baselineRate * 100).toFixed(1)}%  reranked=${(rerankedRate * 100).toFixed(1)}%  efficacy=${((rerankedRate - baselineRate) * 100).toFixed(1)}pp`);
    }
    const overallBaseRate = overallTotal > 0 ? overallBaseline / overallTotal : 0;
    const overallRerankedRate = overallTotal > 0 ? overallReranked / overallTotal : 0;
    append(`${opponentUsername} overall: n=${overallTotal}  baseline=${(overallBaseRate * 100).toFixed(1)}%  reranked=${(overallRerankedRate * 100).toFixed(1)}%  efficacy=${((overallRerankedRate - overallBaseRate) * 100).toFixed(1)}pp\n`);
    return byPhase;
  }

  async function runAll() {
    const usernames = usernamesInput.split(/[\n,]+/).map((username) => username.trim()).filter(Boolean);
    if (usernames.length === 0) return;
    setRunning(true);
    setLog([]);
    append(`Running ${usernames.length} username(s) sequentially: ${usernames.join(", ")}\n`);
    const aggregate: Record<Phase, { baselineMatches: number; rerankedMatches: number; total: number }> = {
      opening: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
      middlegame: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
      endgame: { baselineMatches: 0, rerankedMatches: 0, total: 0 },
    };
    try {
      for (const username of usernames) {
        try {
          const result = await runOne(username);
          for (const phase of PHASES) {
            aggregate[phase].baselineMatches += result[phase].baselineMatches;
            aggregate[phase].rerankedMatches += result[phase].rerankedMatches;
            aggregate[phase].total += result[phase].total;
          }
        } catch (err) {
          append(`!! ${username} FAILED entirely: ${err instanceof Error ? err.message : String(err)} — continuing with next username\n`);
        }
      }
      append(`\n=== Aggregate across all ${usernames.length} usernames, by phase ===`);
      for (const phase of PHASES) {
        const bucket = aggregate[phase];
        if (bucket.total === 0) {
          append(`${phase}: 0 positions — skipped`);
          continue;
        }
        const baselineRate = bucket.baselineMatches / bucket.total;
        const rerankedRate = bucket.rerankedMatches / bucket.total;
        append(`${phase}: n=${bucket.total}  baseline=${(baselineRate * 100).toFixed(1)}%  reranked=${(rerankedRate * 100).toFixed(1)}%  efficacy=${((rerankedRate - baselineRate) * 100).toFixed(1)}pp`);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h2>Maia mimicry efficacy (dev only)</h2>
      <div style={{ marginBottom: 8 }}>
        <div>Opponents (one per line or comma-separated):</div>
        <textarea
          rows={8}
          style={{ width: 400, fontFamily: "monospace" }}
          value={usernamesInput}
          onChange={(event) => setUsernamesInput(event.target.value)}
          disabled={running}
        />
      </div>
      <button disabled={running} onClick={() => void runAll()}>
        {running ? "Running…" : "Run all"}
      </button>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}
