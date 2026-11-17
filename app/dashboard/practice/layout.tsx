import type { ReactNode } from "react";
import { SubTabs } from "@/components/dashboard/SubTabs";

const practiceTabs = [
  { href: "/dashboard/practice", label: "Practice" },
  { href: "/dashboard/practice/daily", label: "Daily" },
  { href: "/dashboard/practice/form", label: "Form" },
  { href: "/dashboard/practice/openings", label: "Openings" },
] as const;

export default function PracticeLayout({ children }: { children: ReactNode }) {
  return <>
    <SubTabs items={practiceTabs} ariaLabel="Practice sections" />
    {children}
  </>;
}
