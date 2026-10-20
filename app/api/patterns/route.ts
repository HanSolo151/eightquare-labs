import { connection, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPatternsData } from "@/lib/patterns/getPatternsData";
import type { Session } from "next-auth";

// Step 4: Screen 3 (Patterns). Like /api/dashboard, this only reads what's
// already persisted — no Stockfish/engine work happens on the server.
//
// Step 6: the query lives in lib/patterns/getPatternsData.ts so the Patterns
// page can call the same function directly instead of fetching its own API.

export async function GET() {
  await connection();
  let session: Session | null;
  try {
    session = await auth();
  } catch (err) {
    console.error("Session read failed in /api/patterns:", err);
    return NextResponse.json({ error: "session unavailable" }, { status: 500 });
  }

  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const data = await getPatternsData(userId);
    return NextResponse.json(data);
  } catch (err) {
    console.error("DB read failed in /api/patterns:", err);
    return NextResponse.json({ error: "patterns data unavailable" }, { status: 500 });
  }
}
