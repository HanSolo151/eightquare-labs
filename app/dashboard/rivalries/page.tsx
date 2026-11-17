import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyRivalriesPage({ searchParams }: PageProps<"/dashboard/rivalries">) {
  redirect(withPreservedQuery("/dashboard/signature/rivalries", await searchParams));
}
