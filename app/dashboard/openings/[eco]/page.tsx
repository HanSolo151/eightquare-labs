import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyOpeningDrilldownPage({ params, searchParams }: PageProps<"/dashboard/openings/[eco]">) {
  const [{ eco }, query] = await Promise.all([params, searchParams]);
  redirect(withPreservedQuery(`/dashboard/practice/openings/${encodeURIComponent(eco)}`, query));
}
