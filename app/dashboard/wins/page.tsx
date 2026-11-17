import { redirect } from "next/navigation";
import { withPreservedQuery } from "@/lib/dashboard/routeRedirect";

export default async function LegacyStyleMatchPage({ searchParams }: PageProps<"/dashboard/wins">) {
  redirect(withPreservedQuery("/dashboard/signature/style-match", await searchParams));
}
