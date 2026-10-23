"use client";

import { useEffect, useState, type FormEvent } from "react";

export default function PreferencesPage() {
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/preferences/player-matches").then(async (response) => {
      if (!response.ok) throw new Error("Could not load preferences.");
      return response.json() as Promise<{ enabled: boolean; email: string }>;
    }).then((data) => {
      if (active) { setEnabled(data.enabled); setEmail(data.email); setLoaded(true); }
    }).catch(() => { if (active) { setLoaded(true); setMessage("Could not load preferences. Refresh and try again."); } });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/preferences/player-matches", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, email }),
      });
      const data = await response.json() as { error?: string; enabled?: boolean; email?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not save preferences.");
      setEnabled(Boolean(data.enabled)); setEmail(data.email ?? ""); setMessage("Preferences saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save preferences."); }
    finally { setBusy(false); }
  }

  return <section className="max-w-2xl space-y-6">
    <header className="border-b border-white/10 pb-5">
      <p className="text-xs uppercase tracking-[0.25em] text-emerald-300">Preferences</p>
      <h1 className="mt-3 text-3xl font-semibold">Player-style match emails</h1>
      <p className="mt-2 text-sm text-neutral-400">Choose whether we email you when an analyzed win matches a player in your style library. You can change this any time.</p>
    </header>
    {!loaded ? <p className="text-sm text-neutral-400">Loading preferences…</p> : <form onSubmit={save} className="space-y-5 rounded-xl border border-white/10 p-5">
      <label className="block space-y-2 text-sm">
        <span>Email address</span>
        <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-lg border border-white/15 bg-black px-3 py-2 text-white" placeholder="you@example.com" />
      </label>
      <label className="flex items-start gap-3 text-sm text-neutral-300">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="mt-1 accent-emerald-400" />
        <span>Email me about player-style matches. We send no more than two match emails per week.</span>
      </label>
      <div className="flex items-center gap-4">
        <button disabled={busy} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-100 disabled:opacity-50">{busy ? "Saving…" : "Save preferences"}</button>
        {message && <p role="status" className="text-sm text-neutral-400">{message}</p>}
      </div>
    </form>}
  </section>;
}
