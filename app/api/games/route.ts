import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/lichess/fetchGames";
import { parseGames } from "@/lib/lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "@/lib/features/extractFeatures";
import { flagMoves, checkProfileWarnings } from "@/lib/flags/flagEngine";

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  try {
    const raw = await fetchGames({ username, max: 5, rated: true, perfType: "rapid" });
    const games = parseGames(raw, username);
    const allFeatures = extractAllMoveFeatures(games);
    const profile = buildPlayerProfile(username, games, allFeatures);
    const flagged = flagMoves(allFeatures, profile);
    const warnings = checkProfileWarnings(profile);

    return NextResponse.json({ games, profile, flagged, warnings });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "fetch/parse failed" }, { status: 500 });
  }
}