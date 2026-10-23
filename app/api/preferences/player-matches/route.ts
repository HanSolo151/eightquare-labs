import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function GET() {
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const preference = await prisma.notificationPreference.findUnique({ where: { userId }, select: { vanityMatchOptIn: true, emailAddress: true } });
  return NextResponse.json({ enabled: preference?.vanityMatchOptIn ?? false, email: preference?.emailAddress ?? "" });
}

export async function PUT(request: NextRequest) {
  const userId = getSessionUserId(await auth());
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid preferences" }, { status: 400 });
  const { enabled, email } = body as { enabled?: unknown; email?: unknown };
  if (typeof enabled !== "boolean" || typeof email !== "string") return NextResponse.json({ error: "enabled and email are required" }, { status: 400 });
  const normalizedEmail = email.trim().toLowerCase();
  if (enabled && !validEmail(normalizedEmail)) return NextResponse.json({ error: "enter a valid email address to enable match emails" }, { status: 400 });
  const preference = await prisma.notificationPreference.upsert({
    where: { userId },
    update: { vanityMatchOptIn: enabled, emailAddress: normalizedEmail || null },
    create: { userId, vanityMatchOptIn: enabled, emailAddress: normalizedEmail || null },
    select: { vanityMatchOptIn: true, emailAddress: true },
  });
  return NextResponse.json({ enabled: preference.vanityMatchOptIn, email: preference.emailAddress ?? "" });
}
