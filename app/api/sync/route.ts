import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { runSync } from "@/lib/sync/runSync";

export async function POST() {
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await runSync(userId, { force: true });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "user not found" ? 404 : 500 }
    );
  }

  return NextResponse.json({
    synced: result.synced,
    totalGames: result.totalGames,
    lastSyncedAt: result.lastSyncedAt,
    lastGameCreatedAt: result.lastGameCreatedAt,
    skipped: result.skipped,
  });
}
