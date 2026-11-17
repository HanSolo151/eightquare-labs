"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SubTabItem {
  href: string;
  label: string;
}

export function SubTabs({ items, ariaLabel }: { items: readonly SubTabItem[]; ariaLabel: string }) {
  const pathname = usePathname();

  return <nav aria-label={ariaLabel} className="-mx-1 mb-6 overflow-x-auto px-1">
    <div className="flex min-w-max gap-1 border-b border-white/10 pb-2">
      {items.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined}
          className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors ${active ? "border-amber-300/30 bg-amber-300/10 text-amber-100" : "border-transparent text-neutral-500 hover:border-white/10 hover:text-neutral-200"}`}>
          {label}
        </Link>;
      })}
    </div>
  </nav>;
}
