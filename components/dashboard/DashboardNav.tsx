"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const primaryTabs = [
  { href: "/dashboard", label: "Practice" },
  { href: "/dashboard/daily", label: "Daily" },
  { href: "/dashboard/signature", label: "Dossier" },
  { href: "/dashboard/patterns", label: "Blind spots" },
  { href: "/dashboard/games", label: "Games" },
] as const;

const moreTabs = [
  { href: "/dashboard/openings", label: "Openings" },
  { href: "/dashboard/form", label: "Form" },
  { href: "/dashboard/wins", label: "Style match" },
  { href: "/dashboard/rivalries", label: "Rivalries" },
] as const;

function isActive(href: string, pathname: string) {
  return href === "/dashboard"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard" className="-mx-2 flex items-center border-b border-neutral-800 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {primaryTabs.map(({ href, label }) => {
          const active = isActive(href, pathname);
          return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`shrink-0 border-b-2 px-2.5 py-3 text-sm transition-colors ${active ? "border-emerald-300 text-white" : "border-transparent text-neutral-500 hover:text-neutral-200"}`}>{label}</Link>;
        })}
      </div>
      <details className="group relative shrink-0">
        <summary className={`cursor-pointer list-none border-b-2 px-2.5 py-3 text-sm transition-colors marker:hidden [&::-webkit-details-marker]:hidden ${moreTabs.some(({ href }) => isActive(href, pathname)) ? "border-emerald-300 text-white" : "border-transparent text-neutral-500 hover:text-neutral-200"}`}>
          More <span aria-hidden="true" className="ml-1 text-[10px]">▾</span>
        </summary>
        <div className="absolute right-0 top-full z-50 mt-2 min-w-44 rounded-lg border border-white/10 bg-[#111] p-1 shadow-xl">
          {moreTabs.map(({ href, label }) => {
            const active = isActive(href, pathname);
            return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`block rounded px-3 py-2 text-sm ${active ? "bg-white/[0.08] text-white" : "text-neutral-400 hover:bg-white/[0.05] hover:text-white"}`}>{label}</Link>;
          })}
        </div>
      </details>
    </nav>
  );
}
