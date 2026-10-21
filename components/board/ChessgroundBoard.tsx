"use client";

import { useEffect, useId, useRef } from "react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { Key } from "chessground/types";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";

interface ChessgroundBoardProps {
  fen: string;
  orientation?: "white" | "black";
  // NEW, Step 10 — all optional, all default to the Step 5 view-only behavior.
  interactive?: boolean;
  turnColor?: "white" | "black";
  dests?: Map<Key, Key[]>; // legal destinations, keyed by origin square — caller (GamePanel) owns chess.js, so it builds this
  lastMove?: [Key, Key]; // highlight the most recent move, from/to
  onUserMove?: (from: Key, to: Key) => void;
  ghostLayers?: { fen: string; tint: string; opacity?: number; label: string }[];
  ghostArrows?: { from: Key; to: Key; tint: string; label: string }[];
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const PIECE_GLYPH: Record<string, string> = {
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
};

function piecesBySquare(fen: string): Record<string, string> {
  const rows = fen.split(" ")[0]?.split("/") ?? [];
  const pieces: Record<string, string> = {};
  rows.forEach((row, rankIndex) => {
    let file = 0;
    for (const character of row) {
      if (/\d/.test(character)) file += Number(character);
      else {
        if (file < 8) pieces[`${FILES[file]}${8 - rankIndex}`] = character;
        file += 1;
      }
    }
  });
  return pieces;
}

function squareOffset(square: string, orientation: "white" | "black") {
  const file = FILES.indexOf(square[0] as (typeof FILES)[number]);
  const rank = Number(square[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  return { left: `${(col / 8) * 100}%`, top: `${(row / 8) * 100}%` };
}

export default function ChessgroundBoard({
  fen,
  orientation = "white",
  interactive = false,
  turnColor = "white", // FIX: was undefined-by-default, which left Chessground's internal turnColor stuck
  dests,
  lastMove,
  onUserMove,
  ghostLayers,
  ghostArrows,
}: ChessgroundBoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const onUserMoveRef = useRef(onUserMove);
  const arrowId = useId().replace(/:/g, "");

  useEffect(() => {
    onUserMoveRef.current = onUserMove;
  }, [onUserMove]);

  // Chessground does not support changing `viewOnly` through api.set().
  // Recreate its controller on the same DOM node when interaction toggles,
  // so the existing board can enter/leave spar mode without rendering a
  // second board.
  useEffect(() => {
    if (!el.current) return;
    const config: Config = {
      fen,
      orientation,
      viewOnly: !interactive,
      coordinates: false,
      turnColor, // FIX: was missing from this config object entirely
      movable: {
        free: false,
        color: interactive ? turnColor : undefined,
        dests,
        events: {
          after: (from, to) => onUserMoveRef.current?.(from, to),
        },
      },
    };
    api.current = Chessground(el.current, config);
    return () => api.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, orientation]);

  useEffect(() => {
    api.current?.set({
      fen,
      orientation,
      turnColor, // FIX: was missing from this .set() call too
      lastMove,
      movable: {
        free: false,
        color: interactive ? turnColor : undefined,
        dests,
      },
    });
  // turnColor is derived from fen, so fen already covers that change.
  // Keeping this dependency list stable also avoids a size mismatch during HMR.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, orientation, interactive, dests, lastMove]);

  const basePieces = ghostLayers?.length ? piecesBySquare(fen) : null;
  return <div style={{ position: "relative", width: "min(480px, 100%)", aspectRatio: "1 / 1" }}>
    <div ref={el} style={{ width: "100%", height: "100%" }} />
    {ghostLayers?.map((layer) => {
      const layerPieces = piecesBySquare(layer.fen);
      const changed = [...new Set([...Object.keys(basePieces ?? {}), ...Object.keys(layerPieces)])]
        .filter((square) => layerPieces[square] !== basePieces?.[square]);
      return <div key={layer.label} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {changed.map((square) => <span key={square} style={{
          position: "absolute", ...squareOffset(square, orientation), width: "12.5%", height: "12.5%",
          display: "grid", placeItems: "center", fontSize: "min(6vw, 32px)",
          color: layer.tint, opacity: layer.opacity ?? 0.55,
          ...(layerPieces[square] ? {} : { boxSizing: "border-box", border: `3px solid ${layer.tint}`, borderRadius: "50%", transform: "scale(.48)" }),
        }}>{layerPieces[square] ? PIECE_GLYPH[layerPieces[square]] : null}</span>)}
      </div>;
    })}
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5, fontSize: "clamp(9px, 1.8vw, 12px)", fontWeight: 600, color: "rgba(255,255,255,.82)", textShadow: "0 1px 2px rgba(0,0,0,.9)" }}>
      {Array.from({ length: 8 }, (_, index) => {
        const rank = orientation === "white" ? 8 - index : index + 1;
        return <span key={`rank-${rank}`} style={{ position: "absolute", left: 0, top: `${index * 12.5}%`, width: "12.5%", height: "12.5%", display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: "3px" }}>{rank}</span>;
      })}
      {Array.from({ length: 8 }, (_, index) => {
        const file = orientation === "white" ? FILES[index] : FILES[7 - index];
        return <span key={`file-${file}`} style={{ position: "absolute", left: `${index * 12.5}%`, bottom: 0, width: "12.5%", height: "12.5%", display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: "2px" }}>{file}</span>;
      })}
    </div>
    {ghostArrows && ghostArrows.length > 0 && <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }}>
      <defs>{ghostArrows.map((arrow, index) => <marker key={arrow.label} id={`${arrowId}-arrow-${index}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0 0 L 5 2.5 L 0 5 z" fill={arrow.tint} />
      </marker>)}</defs>
      {ghostArrows.map((arrow, index) => {
        const origin = squareOffset(arrow.from, orientation);
        const destination = squareOffset(arrow.to, orientation);
        const x1 = Number.parseFloat(origin.left) + 6.25;
        const y1 = Number.parseFloat(origin.top) + 6.25;
        const x2 = Number.parseFloat(destination.left) + 6.25;
        const y2 = Number.parseFloat(destination.top) + 6.25;
        return <line key={arrow.label} x1={x1} y1={y1} x2={x2} y2={y2} stroke={arrow.tint} strokeWidth="1.2" strokeOpacity=".82" markerEnd={`url(#${arrowId}-arrow-${index})`} />;
      })}
    </svg>}
  </div>;
}
