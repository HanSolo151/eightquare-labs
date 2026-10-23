import { NextRequest, NextResponse } from "next/server";
import { deliverPlayerStyleMatches } from "@/lib/matching/deliverMatches";

async function runScheduledJob(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await deliverPlayerStyleMatches()) });
  } catch (error) {
    console.error("Player-style match reranking failed", error);
    return NextResponse.json({ error: "reranking failed" }, { status: 500 });
  }
}

export const GET = runScheduledJob;
export const POST = runScheduledJob;
