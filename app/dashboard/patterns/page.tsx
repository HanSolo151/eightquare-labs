import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyPatternsPage({ searchParams }: PageProps<"/dashboard/patterns">) {
  redirect(withPreservedQuery("/dashboard/signature/patterns", await searchParams));
}
