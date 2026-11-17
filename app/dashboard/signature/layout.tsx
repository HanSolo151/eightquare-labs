import type { ReactNode } from "react";
import { SubTabs } from "@/components/dashboard/SubTabs";

const signatureTabs = [
  { href: "/dashboard/signature", label: "Overview" },
  { href: "/dashboard/signature/heatmap", label: "Heatmap" },
  { href: "/dashboard/signature/patterns", label: "Patterns" },
  { href: "/dashboard/signature/rivalries", label: "Rivalries" },
  { href: "/dashboard/signature/records", label: "Records" },
  { href: "/dashboard/signature/style-match", label: "Style Match" },
] as const;

export default function SignatureLayout({ children }: { children: ReactNode }) {
  return <>
    <SubTabs items={signatureTabs} ariaLabel="Signature sections" />
    {children}
  </>;
}
