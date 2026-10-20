# Build Order (from EightSquare Labs spec, §11)

1. [x] Blind Spot Heatmap — update/read/UI code is in place; migration, existing-game backfill, and browser validation remain.
2. [x] Opening Danger Score + drill-down — relative score from persisted games/flags; interactive move-position spar. Validate against real archive data.
3. [x] Ghost Replay — single-moment three-way comparison (your move / Stockfish / Maia) with spar from the flagged position. Browser validation remains.
   - Not built: scrub bar and synchronized multi-ply continuation evaluation graph from the full spec.
3a. [x] `/dashboard` is now the Spar hero. The player dossier has moved to `/dashboard/signature` and includes the heatmap.
4. [ ] Opponent-Specific Replay (Maia4All tiered model) — partial model support exists in spar; validate tier behavior and coverage.
5. [x] Daily Puzzle from flagged moves — persisted solve/skip state and interactive board are implemented; apply the migration and validate the browser flow.
6. [x] Rivalry Tracker — self-scoped list/detail, matchup openings, flagged-square distribution, and worst flagged-position spar. Browser validation remains.
7. [x] Ambient Pace Signal — retrospective recurring cascade signal on saved game review. Browser validation remains.

## Remaining foundation work

- Apply and verify outstanding migrations/backfill steps where needed.
- Browser-validate the implemented flows against the real archive.
- Spar-session resume/persistence (flag id, attempt index, move list, clock, and 24-hour abandonment handling) is not implemented; there is no `SparSession` table yet.
- Full Ghost Replay continuation graph remains separate scope.
