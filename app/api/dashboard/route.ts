import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId, getSessionPlan } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/getDashboardData";
import type { Session } from "next-auth";

// Step 4: first DB-backed read for Screen 1 (Signature). Everything here is
// a straight read of what sync (Step 2) and eval-push (Step 3) already
// wrote — no computation happens in this route, per the "dashboard reads
// are always from the DB, never recomputed live" decision in the plan.

export async function GET() {
  let session: Session | null;
  try {
    session = await auth();
  } catch (err) {
    console.error("Session read failed in /api/dashboard:", err);
    return NextResponse.json({ error: "session unavailable" }, { status: 500 });
  }

  const userId = getSessionUserId(session);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const data = await getDashboardData(userId);
    if (!data) return NextResponse.json({ error: "user not found" }, { status: 404 });
    return NextResponse.json({ ...data, plan: getSessionPlan(session) });
  } catch (err) {
    console.error("DB read failed in /api/dashboard:", err);
    return NextResponse.json({ error: "dashboard data unavailable" }, { status: 500 });
  }
}
