import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "@/lib/features/extractFeatures";

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  try {
    // Bumped from 5 — timing/move data is cheap (no engine), needed for a real baseline.
    const raw = await fetchGames({ username, max: 25, rated: true, perfType: "rapid" });
    const games = parseGames(raw, username);
    const allFeatures = extractAllMoveFeatures(games);
    const profile = buildPlayerProfile(username, games, allFeatures);

    // Stockfish evaluation and move flagging run incrementally in the browser
    // after this metadata response loads; expensive engine work stays off the API.
    return NextResponse.json({ games, profile });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "fetch/parse failed" }, { status: 500 });
  }
}