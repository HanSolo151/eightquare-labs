import { connection, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getOpeningsData } from "@/lib/openings/getOpeningsData";

export async function GET() {
  await connection();
  try {
    const userId = getSessionUserId(await auth());
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json(await getOpeningsData(userId));
  } catch (error) {
    console.error("Opening data read failed:", error);
    return NextResponse.json({ error: "opening data unavailable" }, { status: 500 });
  }
}
