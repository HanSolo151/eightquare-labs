import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function DashboardIndex({ searchParams }: PageProps<"/dashboard">) {
  redirect(withPreservedQuery("/dashboard/home", await searchParams));
}
