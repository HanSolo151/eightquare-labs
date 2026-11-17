import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyRivalryDetailPage({ params, searchParams }: PageProps<"/dashboard/rivalries/[opponentUsername]">) {
  const [{ opponentUsername }, query] = await Promise.all([params, searchParams]);
  redirect(withPreservedQuery(`/dashboard/signature/rivalries/${encodeURIComponent(opponentUsername)}`, query));
}
