import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPersonalRecords } from "@/lib/dashboard/getSignatureSignals";
import PersonalRecords from "@/components/dashboard/PersonalRecords";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function SignatureRecordsPage() {
  return <Suspense fallback={<DashboardPageFallback />}><SignatureRecordsContent /></Suspense>;
}

async function SignatureRecordsContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to see your records.</p>;
  const records = await getPersonalRecords(userId);

  return <section className="space-y-5 pb-12">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Personal records</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Records</h1>
    </header>
    <PersonalRecords records={records} />
  </section>;
}
