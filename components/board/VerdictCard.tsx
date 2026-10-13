"use client";

import { useState } from "react";
import type { FlaggedMove } from "@/types";
import { OpponentPanel } from "./opponentPanel";

const SEVERITY_LABEL: Record<FlaggedMove["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function formatSentence(flag: FlaggedMove): string {
  return flag.explanation;
}

const FLAG_TYPE_LABEL: Record<FlaggedMove["flagType"], string> = {
  collapse: "Fast-move collapse",
  pattern_repeat: "Recurring weakness",
  tilt_cascade: "Tilt cascade",
  time_paradox: "Slow-move blunder",
};

export default function VerdictCard({
  flag,
  opponentLabel,
  opponentUsername,
  onJump,
  onDismiss,
  onReplay, // NEW, Step 10 — optional so this stays backward compatible if a caller doesn't pass it
}: {
  flag: FlaggedMove;
  opponentLabel?: string;
  opponentUsername?: string;
  onJump: () => void;
  onDismiss: () => void;
  onReplay?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ border: "1px solid #333", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{flag.moveNumber}. {flag.san} · {FLAG_TYPE_LABEL[flag.flagType]}</strong>
        <span style={{ fontSize: 12 }}>{SEVERITY_LABEL[flag.severity]}</span>
      </div>

      {opponentLabel && <div style={{ fontSize: 12, opacity: 0.8 }}>{opponentLabel}</div>}
      <div style={{ fontSize: 13, margin: "6px 0" }}>{formatSentence(flag)}</div>
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Eval loss: {(flag.cpLoss / 100).toFixed(1)} pawns · played in {flag.timeSpentSec.toFixed(1)}s
        ({Math.round(flag.timeRatio * 100)}% of usual)
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onJump}>Jump to move</button>
        <button type="button" onClick={onDismiss}>Dismiss</button>
        {onReplay && (
          <button type="button" onClick={onReplay}>Replay from here</button>
        )}
        {opponentUsername && (
          <button type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide opponent profile" : "Show opponent profile"}
          </button>
        )}
      </div>

      {expanded && opponentUsername && <OpponentPanel opponentUsername={opponentUsername} />}
    </div>
  );
}