import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import HomeScreen from "@/components/dashboard/HomeScreen";
import DashboardPageFallback from "@/components/dashboard/DashboardPageFallback";

export default function HomePage() {
  return <Suspense fallback={<DashboardPageFallback />}><HomePageContent /></Suspense>;
}

async function HomePageContent() {
  const userId = getSessionUserId(await auth());
  if (!userId) return <p className="text-sm text-neutral-400">Sign in to load your dashboard.</p>;
  return <HomeScreen userId={userId} />;
}
