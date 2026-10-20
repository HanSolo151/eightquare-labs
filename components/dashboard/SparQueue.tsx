"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SparQueueItem } from "@/lib/dashboard/getSparQueue";

type ResolvedEvent = CustomEvent<{ gameId: string; ply: number }>;

export default function SparQueue({ initialItems, initialTotal }: { initialItems: SparQueueItem[]; initialTotal: number }) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [settlingKeys, setSettlingKeys] = useState<Set<string>>(() => new Set());
  const activeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => () => {
    for (const timer of activeTimers.current.values()) clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onResolved = (event: Event) => {
      const detail = (event as ResolvedEvent).detail;
      if (!detail || typeof detail.gameId !== "string" || !Number.isInteger(detail.ply)) return;
      const key = `${detail.gameId}:${detail.ply}`;
      if (activeTimers.current.has(key)) return;
      setSettlingKeys((current) => new Set(current).add(key));
      activeTimers.current.set(key, setTimeout(() => {
        activeTimers.current.delete(key);
        setItems((current) => current.filter((item) => `${item.gameId}:${item.ply}` !== key));
        setTotal((current) => Math.max(0, current - 1));
        setSettlingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        router.refresh();
      }, 420));
    };
    window.addEventListener("spar-position-resolved", onResolved);
    return () => window.removeEventListener("spar-position-resolved", onResolved);
  }, [router]);

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-medium">Open flagged moments</h2>
        <span className="font-mono text-xs tabular-nums text-neutral-500">{total} waiting</span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl bg-[#17161A] p-5 text-sm text-neutral-400">Your queue is clear. Successful wins and draws remove their position from this list.</p>
      ) : (
        <ol className="divide-y divide-white/10 rounded-xl bg-[#17161A] px-5">
          {items.map((item) => {
            const key = `${item.gameId}:${item.ply}`;
            const settling = settlingKeys.has(key);
            return <li key={key} className={`overflow-hidden transition-[max-height,opacity,transform] duration-[400ms] ease-out ${settling ? "max-h-0 -translate-y-1 opacity-0" : "max-h-20 opacity-100"}`}>
              <Link href={`/dashboard/games/${encodeURIComponent(item.gameId)}/ghost?ply=${item.ply}`} className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 py-4 transition-colors duration-150 hover:text-white">
                <span className="text-sm text-neutral-200">{item.summary}</span>
                <span className="text-xs capitalize text-neutral-500">{item.severity}</span>
              </Link>
            </li>;
          })}
        </ol>
      )}
      {total > items.length && <p className="text-xs text-neutral-500">Showing {items.length} of {total} positions.</p>}
    </section>
  );
}
