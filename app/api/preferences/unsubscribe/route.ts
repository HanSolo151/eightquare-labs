import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = form.get("token");
  if (typeof token !== "string" || token.length < 20) return NextResponse.redirect(new URL("/unsubscribe/invalid", request.url));
  const result = await prisma.notificationPreference.updateMany({ where: { unsubscribeToken: token }, data: { vanityMatchOptIn: false } });
  if (!result.count) return NextResponse.redirect(new URL("/unsubscribe/invalid", request.url));
  return new NextResponse(`<!doctype html><html><body style="font-family:system-ui;background:#080808;color:#eee;padding:3rem"><h1>You’re unsubscribed</h1><p>Player-style match emails are now turned off.</p><a style="color:#86efac" href="/dashboard/preferences">Manage preferences</a></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
