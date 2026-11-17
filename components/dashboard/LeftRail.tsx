"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard/home", label: "Home", icon: "home" },
  { href: "/dashboard/games", label: "Games", icon: "games" },
  { href: "/dashboard/signature", label: "Signature", icon: "signature" },
  { href: "/dashboard/practice", label: "Practice", icon: "practice" },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === "/dashboard/home") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RailIcon({ name }: { name: (typeof items)[number]["icon"] }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9M9 20v-6h6v6" /></>,
    games: <><path d="M7 4h10l4 5v8l-4 3H7l-4-3V9z" /><path d="M8 11h4m-2-2v4m5-2h.01m2 2h.01" /></>,
    signature: <><path d="M4 19.5V4.5A1.5 1.5 0 0 1 5.5 3H20v18H5.5A1.5 1.5 0 0 1 4 19.5Z" /><path d="M8 7h8M8 11h8m-8 4h5" /></>,
    practice: <><path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7z" /><path d="m9 12 2 2 4-4" /></>,
  } as const;

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0">{paths[name]}</svg>;
}

export function LeftRail() {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);

  return <>
    <aside aria-label="Primary navigation" className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-white/10 bg-[#0b0b0d] py-4 transition-[width] duration-200 md:flex ${expanded ? "w-56" : "w-16"}`}>
      <nav className="flex flex-1 flex-col items-center gap-2 px-2" aria-label="Dashboard">
        {items.map(({ href, label, icon }) => {
          const active = isActive(href, pathname);
          return <Link key={href} href={href} aria-label={label} aria-current={active ? "page" : undefined} title={!expanded ? label : undefined}
            className={`group relative flex min-h-11 w-full items-center gap-3 border-l-2 px-3 text-sm transition-colors ${active ? "border-amber-300 text-amber-200" : "border-transparent text-neutral-500 hover:text-neutral-100"} ${expanded ? "justify-start" : "justify-center"}`}>
            <RailIcon name={icon} />
            {expanded && <span>{label}</span>}
            {!expanded && <span className="pointer-events-none absolute left-full z-50 ml-2 whitespace-nowrap rounded border border-white/10 bg-[#171719] px-2.5 py-1.5 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{label}</span>}
          </Link>;
        })}
      </nav>
      <button type="button" aria-label={expanded ? "Collapse navigation" : "Expand navigation"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className="mx-2 flex min-h-11 items-center justify-center gap-3 border-l-2 border-transparent px-3 text-neutral-500 transition-colors hover:text-white">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-5 w-5 shrink-0"><path d={expanded ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} /></svg>
        {expanded && <span className="text-sm">Collapse</span>}
      </button>
    </aside>

    <nav aria-label="Primary navigation" className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 border-t border-white/10 bg-[#0b0b0d]/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {items.map(({ href, label, icon }) => {
        const active = isActive(href, pathname);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined}
          className={`flex min-h-16 flex-col items-center justify-center gap-1 border-t-2 text-[10px] ${active ? "border-amber-300 text-amber-200" : "border-transparent text-neutral-500"}`}>
          <RailIcon name={icon} />
          <span>{label}</span>
        </Link>;
      })}
    </nav>
  </>;
}
