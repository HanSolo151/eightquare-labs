import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <main className="min-h-screen bg-black p-8 font-mono text-white">
      <p>logged in as {session.user.name}</p>
      <p className="text-sm text-neutral-400">
        plan: {(session.user as { plan?: string }).plan ?? "free"}
      </p>
    </main>
  );
}
