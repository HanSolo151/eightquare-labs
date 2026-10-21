# Ghost Replay status and handoff

## Summary

Ghost Replay is implemented in the app. Its comparison scores now use Stockfish evaluations of the resulting positions from the player's perspective, and “Replay Full Game” opens at the flagged move.

## What exists

- `lib/ghost/getGhostMoment.ts` loads a persisted flagged move for a game owned by the signed-in user and reconstructs the FEN before that move.
- `components/board/GhostReplay.tsx` renders three static board states after the selected move: the move actually played, Stockfish's top move, and base Maia's top move.
- Stockfish and Maia run client-side. Stockfish evaluates all available resulting positions and reports a played-vs-Stockfish delta when both scores are centipawns. Mate and unavailable scores are handled explicitly. Maia is labeled as a behavioral prediction; Stockfish evaluates the resulting Maia position.
- `components/board/PositionSpar.tsx` is available from Ghost Replay. Its spar flow can use opponent mimic profiles when the necessary data/tier is available; otherwise it uses baseline Maia.
- Entry points exist from saved game review (`app/dashboard/games/[gameId]/page.tsx`) and the Spar dashboard (`app/dashboard/page.tsx`). The dashboard also has a queue of flagged plies linking to the matching Ghost Replay position.
- The Ghost Replay route accepts an optional `ply` query parameter. If absent, it selects the game's worst flagged move; if supplied, it selects that exact flagged ply. Invalid or out-of-range query values are rejected by the page.
- “Replay Full Game” passes the selected move position to the saved review, which seeds `GameReplay` at the position after that flagged move.

## Remaining gaps against the proposed Option A scope

1. **No shared visual evaluation bar.** Scores and the played-vs-Stockfish delta are shown as text, not a common bar.
2. **Opponent mimic is available in spar, not as the third comparison board.** The third comparison board is base Maia. Showing an opponent-specific predicted move there would be a separate feature and needs a clear definition of which tier/model is used.
3. **No synchronized scrub bar or multi-ply continuation graph.** These remain deferred.

## Suggested next scope

Treat remaining Ghost Replay work as a targeted pass:

1. Decide whether Option A's third board should stay base Maia (recommended for a clean baseline comparison) or become opponent mimic. Keep actual spar as the place where opponent-specific behavior is played out.
2. Consider a shared visual evaluation bar if it improves readability over the current normalized text scores.
3. Browser-check a real flagged game, a position where Stockfish and Maia agree, one where they differ, and failure/unavailable-engine states.

Do not start the scrub bar or multi-ply simulation as part of this pass. Those remain a separate later scope.

## Validation status

The source changes have not yet had a real-account browser walkthrough. The text score comparison and replay-position flow are implemented but still need browser validation.
