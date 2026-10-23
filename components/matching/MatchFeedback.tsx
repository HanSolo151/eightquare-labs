"use client";

import { useState } from "react";

export function MatchFeedback({ token, initial }: { token: string; initial: boolean | null }) {
  const [feedback, setFeedback] = useState<boolean | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(value: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/matches/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, feedback: value }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save feedback.");
      setFeedback(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save feedback."); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-xl border border-white/10 p-5">
    <h2 className="font-semibold">Was this a useful comparison?</h2>
    <div className="flex gap-3">
      <button type="button" disabled={busy} aria-pressed={feedback === true} onClick={() => void submit(true)} className={`rounded-lg border px-4 py-2 text-sm ${feedback === true ? "border-emerald-300 bg-emerald-300/10 text-emerald-100" : "border-white/15 text-neutral-300"}`}>👍 Yes</button>
      <button type="button" disabled={busy} aria-pressed={feedback === false} onClick={() => void submit(false)} className={`rounded-lg border px-4 py-2 text-sm ${feedback === false ? "border-amber-300 bg-amber-300/10 text-amber-100" : "border-white/15 text-neutral-300"}`}>👎 No</button>
    </div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    {feedback !== null && <p role="status" className="text-xs text-neutral-500">Thanks, your feedback is saved.</p>}
  </section>;
}
