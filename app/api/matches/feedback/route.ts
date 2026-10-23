import { NextRequest, NextResponse } from "next/server";
import { hashMomentLinkToken } from "@/lib/matching/momentLinkToken";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid feedback" }, { status: 400 });
  const { token, feedback } = body as { token?: unknown; feedback?: unknown };
  if (typeof token !== "string" || token.length < 20 || typeof feedback !== "boolean") return NextResponse.json({ error: "invalid feedback" }, { status: 400 });
  const updated = await prisma.gameMoment.updateMany({
    where: { deepLinkTokenHash: hashMomentLinkToken(token), deepLinkExpiresAt: { gt: new Date() }, status: "emailed" },
    data: { feedback },
  });
  if (!updated.count) return NextResponse.json({ error: "This feedback link has expired. Open your dashboard to review the game." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
