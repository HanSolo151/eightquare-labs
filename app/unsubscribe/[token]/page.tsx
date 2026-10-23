import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const instant = false;

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preference = await prisma.notificationPreference.findUnique({ where: { unsubscribeToken: token }, select: { vanityMatchOptIn: true } });
  return <main className="mx-auto max-w-xl space-y-4 rounded-xl border border-white/10 p-6">
    <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Email preferences</p>
    <h1 className="text-2xl font-semibold">{preference ? "Unsubscribe from player-match emails" : "Link unavailable"}</h1>
    {!preference ? <p className="text-sm text-neutral-400">This unsubscribe link is invalid. You can manage your preferences from the dashboard.</p> : preference.vanityMatchOptIn ? <>
      <p className="text-sm text-neutral-400">This will turn off player-style match emails. Other account messages are unaffected.</p>
      <form action="/api/preferences/unsubscribe" method="post"><input type="hidden" name="token" value={token} /><button className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10">Unsubscribe</button></form>
    </> : <p className="text-sm text-neutral-400">You are already unsubscribed from these emails.</p>}
    <Link href="/dashboard" className="block text-sm text-neutral-400 hover:text-white">Dashboard</Link>
  </main>;
}
