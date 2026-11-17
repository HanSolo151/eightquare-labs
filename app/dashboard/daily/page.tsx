import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyDailyPage({ searchParams }: PageProps<"/dashboard/daily">) {
  redirect(withPreservedQuery("/dashboard/practice/daily", await searchParams));
}
