import { NextRequest, NextResponse } from "next/server";
import { extractOpponentFeatures } from "../../../lib/lichess/opponentFeatures";

/**
 * GET /api/opponent?username=...
 *
 * Mirrors app/api/games/route.ts from Step 5: runs server-side (keeps the
 * Lichess fetch off the browser, same rationale as Step 5), returns JSON,
 * 400 on missing username, 500 on pipeline failure.
 *
 * Caching (24h TTL) happens client-side via lib/opponentCache.ts, not
 * here — this route always does a live fetch when called. The client is
 * responsible for checking the cache first and only hitting this route on
 * a cache miss/expiry.
 */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json(
      { error: "username query param is required" },
      { status: 400 }
    );
  }

  try {
    const features = await extractOpponentFeatures(username);
    return NextResponse.json(features);
  } catch (err) {
    console.error("opponent feature extraction failed:", err);
    return NextResponse.json(
      { error: "failed to extract opponent features" },
      { status: 500 }
    );
  }
}