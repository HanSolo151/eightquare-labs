import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getBiasData } from "@/lib/bias/getBiasData";
import type { Session } from "next-auth";

export async function GET() {
  let session: Session | null;
  try {
    session = await auth();
  } catch (err) {
    console.error("Session read failed in /api/bias:", err);
    return NextResponse.json({ error: "session unavailable" }, { status: 500 });
  }

  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await getBiasData(userId));
  } catch (err) {
    console.error("Bias data read failed in /api/bias:", err);
    return NextResponse.json({ error: "bias data unavailable" }, { status: 500 });
  }
}
