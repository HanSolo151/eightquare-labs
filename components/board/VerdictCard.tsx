"use client";

import { useState } from "react";
import type { FlaggedMove, PivotMoveAttribution } from "@/types";
import { OpponentPanel } from "./opponentPanel";

function pivotRankLabel(pivot: PivotMoveAttribution): string {
  if (pivot.wasTopEngineChoice) return "Engine's top choice";
  if (pivot.wasInTopN) return "Within engine's top 3";
  // multiPV only searched the top 3 lines, so a miss outside that window has
  // no recorded rank — reporting a specific "how far outside" number here
  // would be invented, not measured.
  return "Outside engine's top 3 (exact rank not evaluated)";
}

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
  pivotMove, // NEW, Step 3 — caller-resolved (list lookup or flag.pivotMove during replay); null until loaded
  pivotLoading,
  onLoadPivot, // NEW, Step 3 — optional; omit to hide the pivot section entirely
}: {
  flag: FlaggedMove;
  opponentLabel?: string;
  opponentUsername?: string;
  onJump: () => void;
  onDismiss: () => void;
  onReplay?: () => void;
  pivotMove?: PivotMoveAttribution | null;
  pivotLoading?: boolean;
  onLoadPivot?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pivotExpanded, setPivotExpanded] = useState(false);

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
        {onLoadPivot && (
          <button
            type="button"
            onClick={() => {
              setPivotExpanded((v) => !v);
              if (!pivotMove) onLoadPivot();
            }}
          >
            {pivotExpanded ? "Hide pivot analysis" : "Show pivot analysis"}
          </button>
        )}
      </div>

      {expanded && opponentUsername && <OpponentPanel opponentUsername={opponentUsername} />}

      {pivotExpanded && (
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6, paddingTop: 6, borderTop: "1px solid #333" }}>
          {pivotMove === undefined || pivotMove === null ? (
            <div>{pivotLoading ? "Loading pivot analysis…" : "Pivot analysis unavailable for this flag."}</div>
          ) : (
            <>
              <div>
                Pivot: {pivotMove.san} (move {Math.floor(pivotMove.ply / 2) + 1})
              </div>
              <div>{pivotRankLabel(pivotMove)}</div>
              {pivotMove.wasInTopN && !pivotMove.wasTopEngineChoice && (
                <div>Eval gap to engine&apos;s best: {(pivotMove.evalShiftCp / 100).toFixed(2)} pawns</div>
              )}
              <div>
                Position complexity {pivotMove.complexityDelta >= 0 ? "increased" : "decreased"} by{" "}
                {Math.abs(pivotMove.complexityDelta)}{" "}
                {Math.abs(pivotMove.complexityDelta) === 1 ? "reply" : "replies"} after this move
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
