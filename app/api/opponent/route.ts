import { connection, NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { extractOpponentFeatures, emptyOpponentFeatures } from "../../../lib/lichess/opponentFeatures";
import { LichessFetchError } from "../../../lib/lichess/fetchGames";

/**
 * GET /api/opponent?username=...
 *
 * Mirrors app/api/games/route.ts from Step 5: runs server-side (keeps the
 * Lichess fetch off the browser, same rationale as Step 5), returns JSON,
 * 400 on missing username, 401 if not signed in, 403 if the caller has no
 * recorded game against this username, 500 on pipeline failure.
 *
 * Caching (24h TTL) happens client-side via lib/opponentCache.ts, not
 * here — this route always does a live fetch when called. The client is
 * responsible for checking the cache first and only hitting this route on
 * a cache miss/expiry.
 */
export async function GET(req: NextRequest) {
  await connection();
  let session;
  try {
    session = await auth();
  } catch (err) {
    console.error("Session read failed in /api/opponent:", err);
    return NextResponse.json({ error: "session unavailable" }, { status: 500 });
  }
  const userId = getSessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }

  const username = req.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json(
      { error: "username query param is required" },
      { status: 400 }
    );
  }

  try {
    const hasPlayedAgainst = await prisma.game.findFirst({
      where: { userId, opponentUsername: { equals: username, mode: "insensitive" } },
      select: { id: true },
    });
    if (!hasPlayedAgainst) {
      return NextResponse.json(
        { error: "no games recorded against this opponent" },
        { status: 403 }
      );
    }
  } catch (err) {
    console.error("Opponent ownership check failed:", err);
    return NextResponse.json({ error: "failed to verify opponent history" }, { status: 500 });
  }

  try {
    const features = await extractOpponentFeatures(username);
    return NextResponse.json(features);
  } catch (err) {
    if (err instanceof LichessFetchError && err.status === 404) {
      // Opponents can delete accounts, change names, or have unavailable
      // profiles. Their game shouldn't fail just because a profile can't load.
      return NextResponse.json(emptyOpponentFeatures(username));
    }
    console.error("opponent feature extraction failed:", err);
    return NextResponse.json(
      { error: "failed to extract opponent features" },
      { status: 500 }
    );
  }
}
