# Build Order (from EightSquare Labs spec, §11)

1. [ ] Blind Spot Heatmap — update/read/UI code is in place; migration, existing-game backfill, and browser validation remain
2. [x] Opening Danger Score + drill-down — relative score from persisted games/flags; interactive move-position spar. Validate migration-independent reads and UI against real archive data.
3. [ ] Ghost Replay (three-way divergence: you / Stockfish / typical player at rating band)
3a. [ ] **Redirect `/dashboard` to the Spar hero (§8) once step 3 ships.**
    Current `/dashboard` (`app/dashboard/page.tsx`) is pre-revision "Player
    dossier" content — metrics, tempo profile, opening repertoire. It's a
    legitimate placeholder, not the spec'd home page. Do not let it stay
    the permanent `/dashboard` past this step — it has no scheduled
    replacement unless tracked explicitly, which is why this line exists.
4. [ ] Opponent-Specific Replay (Maia4All tiered model) — build alongside 3
5. [ ] Daily Puzzle from flagged moves
6. [ ] Rivalry Tracker (self-facing only — see api/opponent auth fix, done)
7. [ ] Ambient Pace Signal (post-game only, retrospective)
