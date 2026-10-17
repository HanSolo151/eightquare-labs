import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "@/lib/features/extractFeatures";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { FlaggedMove } from "@/types";

// Step 5 (games consistency fix): this route stays a live Lichess fetch —
// it's also the landing-page tool for logged-out visitors and for viewing
// an opponent's games, so it can't become "read the signed-in user's Game
// table" the way /api/dashboard and /api/patterns did. What it was missing
// is any connection to what Step 3 already persisted: `flagged` was always
// returned empty, so even a fully synced-and-evaluated game got its whole
// Stockfish/flag pipeline re-run client-side on every load.
//
// Fix: when the requester is signed in and viewing their own username (same
// sameUser() trim/lowercase rule GamePanel already uses before pushing an
// eval), overlay the persisted FlaggedMove rows and which games already
// have a GameEval, instead of changing the fetch source itself.

function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  try {
    // Bumped from 5 — timing/move data is cheap (no engine), needed for a real baseline.
    const raw = await fetchGames({ username, max: 25, rated: true, perfType: "rapid" });
    const games = parseGames(raw, username);
    const allFeatures = extractAllMoveFeatures(games);
    const profile = buildPlayerProfile(username, games, allFeatures);

    let flagged: FlaggedMove[] = [];
    let evaluatedGameIds: string[] = [];
    const warnings: string[] = [];

    try {
      const session = await auth();
      const sessionUserId = (session?.user as { id?: string } | undefined)?.id;

      if (sessionUserId && sameUser(session?.user?.name, username) && games.length > 0) {
        const gameIds = games.map((g) => g.id);

        const [ownedGames, flagRows] = await Promise.all([
          prisma.game.findMany({
            where: { lichessGameId: { in: gameIds }, userId: sessionUserId },
            select: { lichessGameId: true, eval: { select: { gameId: true } } },
          }),
          prisma.flaggedMove.findMany({
            where: { game: { lichessGameId: { in: gameIds }, userId: sessionUserId } },
            include: { game: { select: { lichessGameId: true } } },
          }),
        ]);

        const ownedIds = new Set(ownedGames.map((g) => g.lichessGameId));
        evaluatedGameIds = ownedGames
          .filter((g) => g.eval)
          .map((g) => g.lichessGameId);

        // Games Lichess returns live but that haven't gone through /api/sync
        // yet can't accept an eval push (eval/push 404s on an unknown game —
        // see Step 3's report). Surface that instead of letting a save fail
        // silently later.
        const unsyncedCount = games.length - ownedIds.size;
        if (unsyncedCount > 0) {
          warnings.push(
            `${unsyncedCount} of ${games.length} games aren't synced to your account yet — ` +
              `run Sync from the dashboard so their analysis can be saved.`
          );
        }

        flagged = flagRows.map((f) => ({
          gameId: f.game.lichessGameId,
          ply: f.ply,
          moveNumber: f.moveNumber,
          san: f.san,
          color: f.color as FlaggedMove["color"],
          flagType: f.flagType as FlaggedMove["flagType"],
          timeSpentSec: f.timeSpentSec,
          phaseAvgSec: f.phaseAvgSec,
          timeRatio: f.timeRatio,
          ratio: f.ratio,
          clockRemainingSec: f.clockRemainingSec,
          gamePhase: f.gamePhase as FlaggedMove["gamePhase"],
          cpLoss: f.cpLoss,
          causality: f.causality as unknown as FlaggedMove["causality"],
          matchedWeaknessId: f.matchedWeaknessId,
          styleDeviationScore: f.styleDeviationScore,
          absoluteAnomalyScore: f.absoluteAnomalyScore,
          severity: f.severity as FlaggedMove["severity"],
          severityBreakdown: f.severityBreakdown as unknown as FlaggedMove["severityBreakdown"],
          pivotMove: f.pivotMove as unknown as FlaggedMove["pivotMove"],
          cascadeMeta: f.cascadeMeta as unknown as FlaggedMove["cascadeMeta"],
          evalConfidence: f.evalConfidence as FlaggedMove["evalConfidence"],
          explanation: f.explanation,
        }));
      }
    } catch (overlayErr) {
      console.error("Session/DB overlay failed for /api/games (serving live data without it):", overlayErr);
      flagged = [];
      evaluatedGameIds = [];
      warnings.length = 0;
    }

    // Stockfish evaluation and move flagging for anything not already
    // persisted still runs incrementally in the browser after this response
    // loads; expensive engine work stays off the API either way.
    return NextResponse.json({ games, profile, flagged, evaluatedGameIds, warnings });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "fetch/parse failed" }, { status: 500 });
  }
}
