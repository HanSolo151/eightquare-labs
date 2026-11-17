import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyOpeningsPage({ searchParams }: PageProps<"/dashboard/openings">) {
  redirect(withPreservedQuery("/dashboard/practice/openings", await searchParams));
}
