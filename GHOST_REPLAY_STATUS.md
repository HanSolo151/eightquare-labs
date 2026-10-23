# Ghost Replay status and handoff

## Summary

Ghost Replay is implemented in the app. Its comparison scores now use Stockfish evaluations of the resulting positions from the player's perspective, and “Replay Full Game” opens at the flagged move. Ghost Progression generates two six-ply-or-shorter continuations from the selected game position and caches each position locally in the browser.

## What exists

- `lib/ghost/getGhostMoment.ts` loads a persisted flagged move for a game owned by the signed-in user and reconstructs the FEN before that move.
- `components/board/GhostReplay.tsx` renders three static board states after the selected move: the move actually played, Stockfish's top move, and base Maia's top move.
- Stockfish and Maia run client-side. Stockfish evaluates all available resulting positions and reports a played-vs-Stockfish delta when both scores are centipawns. Mate and unavailable scores are handled explicitly. Maia is labeled as a behavioral prediction; Stockfish evaluates the resulting Maia position.
- `components/board/PositionSpar.tsx` is available from Ghost Replay. Its spar flow can use opponent mimic profiles when the necessary data/tier is available; otherwise it uses baseline Maia.
- Ghost Progression is generated after an explicit click, then updates automatically as the user navigates to a different game position. Each line projects up to six plies (three full moves): Stockfish chooses both sides in the baseline; Maia predicts moves for the side to move (conditioned on that side's saved game-time rating) while Stockfish chooses replies in the second line. The line continues through a decisive evaluation to preserve the requested three-move projection; the first decisive ply is marked in the line. Generation ends at six plies or when the game position is over. Maia runs in the existing browser worker and Stockfish uses the existing browser worker pool; no progression API route was added.
- Maia receives ratings stored on the original Lichess game record at sync time. Navigating the replay selects the stored rating for whichever side is predicted; it does not look up current ratings.
- Completed progressions are cached in local IndexedDB. Closing the tab during generation loses that in-flight continuation; there is no server-side resumable evaluation queue.
- Generated line PGNs and per-ply FENs are cached in browser IndexedDB by game and selected ply. This is device-local. The UI labels the second line as a Maia prediction and fades later plies to communicate increasing uncertainty.
- Entry points exist from saved game review (`app/dashboard/games/[gameId]/page.tsx`) and the Spar dashboard (`app/dashboard/page.tsx`). The dashboard also has a queue of flagged plies linking to the matching Ghost Replay position.
- The Ghost Replay route accepts an optional `ply` query parameter. If absent, it selects the game's worst flagged move; if supplied, it selects that exact flagged ply. Invalid or out-of-range query values are rejected by the page.
- “Replay Full Game” passes the selected move position to the saved review, which seeds `GameReplay` at the position after that flagged move.

## Remaining gaps against the proposed Option A scope

1. **No shared visual evaluation bar.** Scores and the played-vs-Stockfish delta are shown as text, not a common bar.
2. **Opponent mimic is available in spar, not as the third comparison board.** The third comparison board is base Maia. Showing an opponent-specific predicted move there would be a separate feature and needs a clear definition of which tier/model is used.
3. **No synchronized full-game scrub bar or open-ended continuation graph.** Progression is limited to two fixed lines of at most six plies; cached lines do not sync across devices.

## Suggested next scope

Treat remaining Ghost Replay work as a targeted pass:

1. Decide whether Option A's third board should stay base Maia (recommended for a clean baseline comparison) or become opponent mimic. Keep actual spar as the place where opponent-specific behavior is played out.
2. Consider a shared visual evaluation bar if it improves readability over the current normalized text scores.
3. Browser-check a real flagged game, a position where Stockfish and Maia agree, one where they differ, and failure/unavailable-engine states.

The fixed-length progression is implemented; keep a synchronized full-game scrub bar and open-ended branching continuation graph as separate future scope.

## Validation status

The source changes have not yet had a real-account browser walkthrough. The text score comparison and replay-position flow are implemented but still need browser validation.

## Snapshot checks (2026-10-22)

- `npx tsc --noEmit`, `npm run lint`, and `npm run build` completed successfully.
- `npx prisma migrate status` reported the configured database schema up to date. No migration was applied during this check. The `ResolvedSparPosition` P2021 handler is therefore fallback behavior, not an error observed in this database.
