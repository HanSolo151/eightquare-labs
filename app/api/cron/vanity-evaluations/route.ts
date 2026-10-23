import { NextRequest, NextResponse } from "next/server";
import { processNextVanityEvaluation } from "@/lib/matching/vanityEvaluationQueue";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await processNextVanityEvaluation()) });
  } catch (error) {
    console.error("Vanity evaluation queue processing failed", error);
    return NextResponse.json({ error: "vanity evaluation failed" }, { status: 500 });
  }
}
