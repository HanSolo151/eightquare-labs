"use client";

import { useState } from "react";

export default function UsernameForm({
  onSubmit,
}: {
  onSubmit: (username: string) => void;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <label htmlFor="lichess-username">Lichess username</label>
      <input
        id="lichess-username"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. brino"
        autoFocus
      />
      <button type="submit" disabled={!value.trim()}>
        Load games
      </button>
    </form>
  );
}