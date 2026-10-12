"use client";

import { useEffect, useRef } from "react";
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
}

export default function ChessgroundBoard({
  fen,
  orientation = "white",
  interactive = false,
  turnColor = "white", // FIX: was undefined-by-default, which left Chessground's internal turnColor stuck
  dests,
  lastMove,
  onUserMove,
}: ChessgroundBoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const onUserMoveRef = useRef(onUserMove);
  onUserMoveRef.current = onUserMove;

  useEffect(() => {
    if (!el.current) return;
    const config: Config = {
      fen,
      orientation,
      viewOnly: !interactive,
      coordinates: true,
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
  }, []); // mount once, same as Step 5

  useEffect(() => {
    api.current?.set({
      fen,
      orientation,
      viewOnly: !interactive,
      turnColor, // FIX: was missing from this .set() call too
      lastMove,
      movable: {
        free: false,
        color: interactive ? turnColor : undefined,
        dests,
      },
    });
  }, [fen, orientation, interactive, turnColor, dests, lastMove]);

  return <div ref={el} style={{ width: 480, height: 480 }} />;
}