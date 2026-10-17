import { Suspense, type ReactNode } from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/dashboard/DashboardNav";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="bg-math-grid min-h-screen font-mono text-white">
      <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        <Suspense fallback={<DashboardLoading />}>
          <AuthenticatedDashboard>{children}</AuthenticatedDashboard>
        </Suspense>
      </div>
    </div>
  );
}

async function AuthenticatedDashboard({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <>
      <header className="space-y-5">
        <p className="text-sm text-neutral-400">logged in as {session.user.name}</p>
        <DashboardNav />
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
