import { NextRequest, NextResponse } from "next/server";
import { processNextVanityEvaluation } from "@/lib/matching/vanityEvaluationQueue";

export const maxDuration = 300;
const MAX_JOBS_PER_RUN = 8;
const MAX_RUN_MS = 240_000;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    let claimed = 0;
    let completed = 0;
    while (claimed < MAX_JOBS_PER_RUN && Date.now() - startedAt < MAX_RUN_MS) {
      const result = await processNextVanityEvaluation();
      if (!result.claimed) break;
      claimed++;
      if (result.completed) completed++;
    }
    return NextResponse.json({ ok: true, claimed, completed, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    console.error("Vanity evaluation queue processing failed", error);
    return NextResponse.json({ error: "vanity evaluation failed" }, { status: 500 });
  }
}
