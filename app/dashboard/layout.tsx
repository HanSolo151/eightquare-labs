import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { LeftRail } from "@/components/dashboard/LeftRail";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="bg-math-grid min-h-screen font-mono text-white md:flex">
      <Suspense fallback={null}><LeftRail /></Suspense>
      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 pb-24 sm:px-6 sm:py-8 md:pb-8">
          <Suspense fallback={<DashboardLoading />}>
            <AuthenticatedDashboard>{children}</AuthenticatedDashboard>
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function AuthenticatedDashboard({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <>
      <header>
        <div className="mb-6 flex items-center justify-between gap-3 border-b border-white/10 pb-3 text-xs">
          <Link href="/dashboard" className="font-semibold tracking-wide text-neutral-200 hover:text-white">EIGHTSQUARE</Link>
          <p className="truncate text-neutral-500">{session.user.name}</p>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}

function DashboardLoading() {
  return (
    <div aria-busy="true" className="space-y-8">
      <header className="space-y-5">
        <div className="h-4 w-40 animate-pulse rounded bg-neutral-800" />
        <div className="h-11 animate-pulse border-b border-neutral-800" />
      </header>
      <main className="text-sm text-neutral-500">Loading dashboard…</main>
    </div>
  );
}
