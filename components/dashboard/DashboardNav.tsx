"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/dashboard", label: "Spar" },
  { href: "/dashboard/signature", label: "Signature" },
  { href: "/dashboard/openings", label: "Openings" },
  { href: "/dashboard/daily", label: "Daily" },
  { href: "/dashboard/rivalries", label: "Rivalries" },
  { href: "/dashboard/games", label: "Games" },
  { href: "/dashboard/patterns", label: "Patterns" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard" className="flex gap-6 border-b border-neutral-800">
      {tabs.map(({ href, label }) => {
        const active = href === "/dashboard"
          ? pathname === href
          : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-1 py-3 text-sm ${
              active
                ? "border-white text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
