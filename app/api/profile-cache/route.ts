import { connection, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { readUserProfileCache } from "@/lib/profile-cache-data";

export async function GET() {
  await connection();
  const session = await auth();
  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const profile = await readUserProfileCache(userId);
    if (!profile) return NextResponse.json({ error: "user not found" }, { status: 404 });
    return NextResponse.json(profile);
  } catch (error) {
    console.error("Postgres profile cache read failed:", error);
    return NextResponse.json({ error: "profile data unavailable" }, { status: 500 });
  }
}
