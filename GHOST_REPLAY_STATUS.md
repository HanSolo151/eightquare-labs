# Ghost Replay status and handoff

## Summary

Ghost Replay is implemented in the app. The next task is to close specific comparison and navigation gaps; rebuilding the feature from scratch would duplicate existing work.

## What exists

- `lib/ghost/getGhostMoment.ts` loads a persisted flagged move for a game owned by the signed-in user and reconstructs the FEN before that move.
- `components/board/GhostReplay.tsx` renders three static board states after the selected move: the move actually played, Stockfish's top move, and base Maia's top move.
- Stockfish and Maia run client-side. The component reports the stored cp-loss for the played move and Stockfish's score for its search. Maia is explicitly described as a base prediction, not an opponent-specific prediction.
- `components/board/PositionSpar.tsx` is available from Ghost Replay. Its spar flow can use opponent mimic profiles when the necessary data/tier is available; otherwise it uses baseline Maia.
- Entry points exist from saved game review (`app/dashboard/games/[gameId]/page.tsx`) and the Spar dashboard (`app/dashboard/page.tsx`). The dashboard also has a queue of flagged plies linking to the matching Ghost Replay position.
- The Ghost Replay route accepts an optional `ply` query parameter. If absent, it selects the game's worst flagged move; if supplied, it selects that exact flagged ply. Invalid or out-of-range query values are rejected by the page.

## Gaps against the proposed Option A scope

1. **No common post-move evaluation bar.** Stockfish currently scores the pre-move position from the side-to-move perspective. The UI does not evaluate all three resulting positions on a common scale or display a shared bar.
2. **No explicit move-quality comparison.** The UI does not calculate/display the evaluation difference between the played move and Stockfish's choice. The stored cp-loss and Stockfish score currently describe different things and should not be presented as directly comparable without normalizing perspective and evaluation positions.
3. **Full-game replay does not select the flagged ply.** The Ghost page links to the saved game review, but that link does not currently carry replay position state into `GameReplay`.
4. **Opponent mimic is available in spar, not as the third comparison board.** The third comparison board is base Maia. Showing an opponent-specific predicted move there would be a separate feature and needs a clear definition of which tier/model is used.
5. **No synchronized scrub bar or multi-ply continuation graph.** These are explicitly deferred; they are not needed to complete the one-move Option A scope.

## Suggested next scope

Treat this as a targeted completion pass on the existing Ghost Replay:

1. Decide whether Option A's third board should stay base Maia (recommended for a clean baseline comparison) or become opponent mimic. Keep actual spar as the place where opponent-specific behavior is played out.
2. If adding the eval bar, evaluate each resulting position with Stockfish and normalize all values to the same player's perspective. Label clearly that the Maia move is a behavioral prediction, while the displayed post-move evaluation is Stockfish's assessment of that resulting position.
3. Add the played-vs-Stockfish delta only after that normalization; handle mate scores and unavailable evaluations explicitly.
4. Add a replay-position parameter to the saved-game review route/component so “Replay Full Game” opens at the selected ply.
5. Browser-check a real flagged game, a position where Stockfish and Maia agree, one where they differ, and failure/unavailable-engine states.

Do not start the scrub bar or multi-ply simulation as part of this pass. Those remain a separate later scope.

## Validation status

The existing Ghost Replay path has been reviewed in source. This report does not claim a current browser walkthrough of the complete flow or validation of the proposed evaluation bar, since that bar is not implemented yet.
