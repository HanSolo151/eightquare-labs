import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getGamesData } from "@/lib/dashboard/getGamesData";
import type { Session } from "next-auth";

export async function GET(request: Request) {
  let session: Session | null;
  try {
    session = await auth();
  } catch (err) {
    console.error("Session read failed in /api/dashboard/games:", err);
    return NextResponse.json({ error: "session unavailable" }, { status: 500 });
  }

  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rawPage = new URL(request.url).searchParams.get("page");
  const page = rawPage && /^\d+$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  try {
    return NextResponse.json(await getGamesData(userId, page));
  } catch (err) {
    console.error("DB read failed in /api/dashboard/games:", err);
    return NextResponse.json({ error: "games data unavailable" }, { status: 500 });
  }
}
