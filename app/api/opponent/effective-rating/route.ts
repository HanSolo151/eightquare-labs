import { connection, NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getEffectiveRatingSignal } from "@/lib/opponent/effectiveRating";

export async function GET(request: NextRequest) {
  await connection();
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const username = request.nextUrl.searchParams.get("username")?.trim();
  if (!username || username.length > 100 || /[\u0000-\u001f]/.test(username)) {
    return NextResponse.json({ error: "invalid username" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getEffectiveRatingSignal(userId, username));
  } catch (error) {
    console.error("Effective opponent rating lookup failed:", error);
    return NextResponse.json({ error: "effective rating unavailable" }, { status: 500 });
  }
}
