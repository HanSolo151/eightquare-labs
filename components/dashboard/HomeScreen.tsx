"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import type { UserProfileCache } from "@/lib/profile-cache-types";
import { loadProfile } from "@/lib/profile-cache";
import EarlyRead from "@/components/dashboard/EarlyRead";
import LockedCard from "@/components/dashboard/LockedCard";

interface HomeSummary {
  resolvedKeys: string[];
  weeklyResolvedCount: number;
  totalGames: number;
  evaluatedGames: number;
  recentGames: Array<{
    gameId: string;
    opponentUsername: string;
    result: string;
    openingName: string | null;
    playedAt: number | null;
  }>;
}

function labelForFlagType(flagType: string): string {
  const labels: Record<string, string> = {
    decision_error: "Unrecovered evaluation loss",
    evaluation_cascade: "Multi-move evaluation loss",
    collapse: "Fast-move collapse",
    pattern_repeat: "Recurring weakness",
    tilt_cascade: "Tilt cascade",
    time_paradox: "Slow-move blunder",
  };
  return labels[flagType] ?? "Flagged evaluation loss";
}

export default function HomeScreen({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<UserProfileCache | null>(null);
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const handleProfileRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ newGamesCount: number }>).detail;
      if (typeof detail?.newGamesCount === "number") {
        setProfile((current) => current ? { ...current, pendingNewGamesCount: detail.newGamesCount } : current);
      }
    };
    window.addEventListener("eightsquare:profile-cache-refreshed", handleProfileRefresh);
    void loadProfile(userId).then((value) => {
      if (active) setProfile(value);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    void fetch("/api/profile-cache/home", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load Home data (${response.status}).`);
      return await response.json() as HomeSummary;
    }).then((value) => {
      if (active) setSummary(value);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
    return () => {
      active = false;
      window.removeEventListener("eightsquare:profile-cache-refreshed", handleProfileRefresh);
    };
  }, [userId]);

  const unresolvedFlags = useMemo(() => {
    if (!profile || !summary) return [];
    const resolved = new Set(summary.resolvedKeys);
    const severityRank = { high: 3, medium: 2, low: 1 } as const;
    return profile.flaggedMoments.filter((flag) => !resolved.has(`${flag.internalGameId}:${flag.ply}`))
      .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || (b.cpLoss ?? -1) - (a.cpLoss ?? -1));
  }, [profile, summary]);

  const lead = unresolvedFlags[0];
  const weekTotal = 7;
  const weekDone = Math.min(summary?.weeklyResolvedCount ?? 0, weekTotal);

  return <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mx-auto max-w-4xl space-y-8 pb-12">
    <header className="border-b border-white/10 pb-5">
      <p className="text-xs uppercase tracking-[0.28em] text-amber-200/80">Home</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">One position to face</h1>
      {profile && profile.pendingNewGamesCount > 0 && <Link role="status" href="/dashboard/signature#game-sync" className="mt-3 inline-flex rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1 text-xs text-amber-100 hover:border-amber-200/50">{profile.pendingNewGamesCount} new Lichess games available · review sync</Link>}
    </header>

    {lead ? <section className="space-y-5 border-b border-white/10 pb-7">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Highest-severity unresolved moment</p>
        <p className="mt-3 text-xl leading-8 text-neutral-100 sm:text-2xl">
          {lead.result === "loss" ? `You lost to ${lead.opponentUsername}` : `In your game vs ${lead.opponentUsername}`} — {lead.san}, move {lead.moveNumber}, {lead.cpLoss === null ? lead.mateAfter !== null && lead.mateAfter < 0 ? `allowed mate in ${Math.abs(lead.mateAfter)}` : `gave up mate in ${lead.mateBefore ?? "?"}` : `${Math.round(lead.cpLoss)}cp loss`}.
        </p>
        <p className="mt-2 text-sm font-medium capitalize text-amber-200">{labelForFlagType(lead.flagType)}</p>
      </div>
      <Link href={`/dashboard/games/${encodeURIComponent(lead.internalGameId)}?ply=${lead.ply}`} className="inline-flex rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-200">
        Confront it
      </Link>
    </section> : <section className="border-b border-white/10 pb-7">
      <p className="text-lg text-neutral-200">{profile && summary ? "No unresolved flagged moments right now." : "Your profile is loading from this device or the saved account."}</p>
      {error && <p role="alert" className="mt-2 text-xs text-amber-200">{error}</p>}
      {profile && !lead && <Link href="/dashboard/practice" className="mt-3 inline-flex text-sm text-amber-200 hover:text-white">Go to Practice →</Link>}
    </section>}

    <LockedCard current={weekDone} total={weekTotal} label="Flagged positions drilled this week · weekly goal" />

    {profile && <EarlyRead
      flags={profile.flaggedMoments.map((flag) => ({ gameId: flag.internalGameId, phase: flag.gamePhase, cpLoss: flag.cpLoss }))}
      evaluatedGames={summary?.evaluatedGames ?? 0}
      totalGames={summary?.totalGames ?? 0}
    />}

    <section>
      <div className="flex items-center justify-between border-b border-white/10 pb-2">
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">Recent games</h2>
        <Link href="/dashboard/games" className="text-xs text-neutral-400 hover:text-white">All games →</Link>
      </div>
      {summary?.recentGames.length ? <ul className="divide-y divide-white/[0.07]">
        {summary.recentGames.map((game) => <li key={game.gameId}>
          <Link href={`/dashboard/games/${encodeURIComponent(game.gameId)}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm hover:text-white">
            <span className="text-neutral-200">vs {game.opponentUsername}<span className="ml-2 text-xs capitalize text-neutral-500">{game.result}</span></span>
            <span className="text-xs text-neutral-500">{game.openingName ?? "Opening unavailable"}</span>
          </Link>
        </li>)}
      </ul> : <p className="py-4 text-sm text-neutral-500">{summary ? "No games are saved yet." : "Recent games will appear here."}</p>}
    </section>
  </motion.main>;
}
