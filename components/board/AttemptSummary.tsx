"use client";

import type { FlaggedMove } from "@/types";

interface AttemptSummaryProps {
  flag: FlaggedMove;
  replaySan: string | null;      // the user's first move in the replay, null if game ended before they moved (shouldn't happen, but guarded)
  replayTimeSec: number | null;  // wall-clock seconds from board-interactive to that first move
  outcome: string;               // replayResult string from GamePanel, e.g. "Checkmate — you win"
  onRetry: () => void;
  onExit: () => void;
}

export default function AttemptSummary({
  flag,
  replaySan,
  replayTimeSec,
  outcome,
  onRetry,
  onExit,
}: AttemptSummaryProps) {
  return (
    <div style={{ border: "1px solid #333", borderRadius: 6, padding: "10px 12px", marginTop: 8 }}>
      <h4 style={{ marginTop: 0, marginBottom: 8 }}>Attempt summary</h4>

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 8, fontSize: 13 }}>
        <span style={{ opacity: 0.7 }}>Original move:</span>
        <span>{flag.moveNumber}. {flag.san} — {flag.timeSpentSec.toFixed(1)}s</span>

        <span style={{ opacity: 0.7 }}>Your replay move:</span>
        <span>
          {replaySan ?? "—"}
          {replayTimeSec !== null ? ` — ${replayTimeSec.toFixed(1)}s` : ""}
        </span>

        <span style={{ opacity: 0.7 }}>Outcome:</span>
        <span>{outcome}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" onClick={onRetry}>Retry</button>
        <button type="button" onClick={onExit}>Exit replay</button>
      </div>
    </div>
  );
}