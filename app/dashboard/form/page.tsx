import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyFormPage({ searchParams }: PageProps<"/dashboard/form">) {
  redirect(withPreservedQuery("/dashboard/practice/form", await searchParams));
}
