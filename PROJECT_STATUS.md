# EightSquare Labs — Project Status and Governing-Agent Handoff

**Snapshot:** 2026-10-21
**Purpose:** Describe what the repository currently implements, how its data moves, and what remains before product polish or additional feature work. This is a source-grounded handoff, not a claim that every path has been verified against the live database or in a browser.

## 1. Executive overview

EightSquare Labs is a chess-game review and training app built around a deliberate split: Lichess provides game data; expensive chess analysis runs in the user's browser; selected analysis results are persisted to the app's PostgreSQL database so account-level archive and dashboard pages can read them later.

The product currently includes:

- Lichess OAuth sign-in and per-account data ownership.
- Game sync from Lichess into a Prisma/PostgreSQL archive.
- Browser-side Stockfish evaluation and move-quality flagging, with results pushed back to the database.
- A live Lichess game-inspection page with saved-evaluation overlays and interactive Maia spar/replay.
- A database-backed Games archive, saved-game review, Ghost Replay, opening analytics, pattern views, a square heatmap, Daily Puzzle, and Rivalries.
- Base Maia spar plus an opponent-mimic mode that uses locally built opponent signals when the tier resolver allows it.

The feature set is substantial, but several areas remain “implemented in source, validation outstanding.” All eight local migrations were reported applied to the configured database on 2026-10-22. Browser flows still need a real-account pass, and some analytics are intentionally proxies or partial versions of the larger spec.

## 2. Technology and runtime layout

- **Web:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4.
- **Chess rules/board:** `chess.js` for replay and position construction; Chessground for interactive and static boards.
- **Evaluation:** Stockfish WASM workers and Maia ONNX inference run client-side. The Stockfish engine uses a small worker pool and queued requests. The app proxies Stockfish assets through `/api/stockfish/[asset]`.
- **Server/data:** Auth.js (NextAuth v5 beta), Prisma 6, PostgreSQL (configured for Supabase in this environment).
- **External data:** Lichess public games/account APIs.
- **Client persistence:** IndexedDB for game evaluations and profile caches; localStorage for some UI/account conveniences, dismissal state, and attempt logs.
- **Checks:** `package.json` has `dev`, `build`, `start`, `lint`, and Playwright `test:e2e`. TypeScript is run separately with `npx tsc --noEmit`.

## 3. Architecture and data flow

```mermaid
flowchart LR
  L[Lichess OAuth and games API] --> S[Next.js server routes]
  S --> DB[(PostgreSQL via Prisma)]
  L -->|live recent games| G[Browser GamePanel]
  G -->|Stockfish WASM + Maia ONNX| E[Browser evaluation and replay]
  E -->|completed eval, flags, profile inputs| P[POST /api/eval/push]
  P --> DB
  DB --> D[Dashboard and saved archive pages]
  G --> IDB[(Browser IndexedDB caches)]
```

1. **Sync:** `POST /api/sync` or the Signature page's SyncPanel calls `lib/sync/runSync.ts`. The server fetches the authenticated user's games from Lichess and inserts them into `Game` rows.
2. **Evaluation:** the root review page (`/`) fetches recent games through `GET /api/games`. `GamePanel` runs Stockfish evaluation and feature/flag extraction in the browser for games lacking a persisted `GameEval`.
3. **Persistence:** completed evaluation payloads are sent to `POST /api/eval/push`. The server checks ownership and payload shape, then writes the evaluation and flags and updates aggregated profile rows.
4. **Reading:** `/dashboard/*` archive and analytics views read the signed-in user's persisted database rows. They do not run Stockfish on the server.
5. **Mimic spar:** opponent-history/profile data may be fetched and folded into browser caches; Maia inference and move selection remain in the browser.

### Important source distinction

`GET /api/games` is still a **live Lichess fetch**, currently requesting up to 25 rated rapid games. For a signed-in user viewing their own username, the route overlays persisted flags and evaluated game IDs for matching games. It is not the dashboard archive source. The archive at `/dashboard/games` reads the account-scoped `Game` table.

This distinction is intentional: the root page can inspect a username or opponent live, while dashboard pages are durable account-owned data. A live game that has not yet been synced cannot accept `/api/eval/push`; the games route reports a warning for that case.

## 4. Authentication and ownership

- Auth.js uses a custom Lichess OAuth provider with PKCE/state checks.
- The stable identity key is Lichess `providerAccountId`/account ID, stored as unique `User.lichessId`; username is display data and can change.
- JWT sessions carry the internal database `userId`, username, and plan. Server reads use `getSessionUserId` rather than trusting a client-supplied user ID.
- OAuth tokens are encrypted by `lib/auth/tokenEncryption.ts` before storage. `lib/auth.config.ts` is the edge-safe middleware config; `lib/auth.ts` adds database callbacks for Node/server routes.
- For `AUTH_SECRET` rotation, configure the new value as `AUTH_SECRET` and the old value as `AUTH_SECRET_PREVIOUS`. Auth.js accepts sessions signed with either secret while issuing new sessions with the current secret. Run `npm run rotate:oauth-tokens` while both values are set to re-encrypt stored provider tokens, then remove `AUTH_SECRET_PREVIOUS` after the script succeeds.
- Game rows use an internal database `id` and the external `lichessGameId`. Uniqueness is `(userId, lichessGameId)`, allowing the same Lichess game to be associated with multiple accounts without cross-account ownership collisions.
- Dashboard game, puzzle, rivalry, and analysis APIs scope reads/writes to the authenticated account. The game-review page and Ghost Replay lookup also verify `userId`.

## 5. Persistence model

Defined in `prisma/schema.prisma`:

- **`User`** — Lichess ID, username, free-plan default, encrypted OAuth tokens, sync watermark/timestamps.
- **`Game`** — account-owned Lichess game metadata, moves/clocks JSON, result, color, ratings, opening metadata, and speed.
- **`GameEval`** — one JSON array of per-ply Stockfish `EvalPoint`s per internal game ID.
- **`FlaggedMove`** — persisted move-level observations: SAN/ply, flag type, time/phase ratios, cp loss, causality, severity breakdown, optional pivot/cascade metadata, explanation.
- **`PlayerProfile`** — broad account aggregates such as phase timing, premove rate, opening counts, average opponent rating.
- **`WeaknessProfileRow`** — incrementally accumulated patterns and evaluated game IDs.
- **`BiasProfile`** — square-level bias JSON, evaluated game IDs, sample count, confidence, and legacy rank/file/diagonal JSON columns.
- **`DailyPuzzleState`** — per-user, per-game, per-ply skip/cooldown/defer state and compatibility markers for Daily Puzzle solves.
- **`ResolvedSparPosition`** — account-owned resolved flagged positions across Daily Puzzle, Ghost Replay, opening drills, saved-game replay, and rivalry drills.

The current migration folders are:

1. `20261016220651_init`
2. `20261017132319_add_flaggedmove_ratio`
3. `20261018150000_scope_games_to_user`
4. `20261018150100_clear_plaintext_oauth_tokens`
5. `20261019100000_add_square_bias`
6. `20261019120000_add_daily_puzzle_state`
7. `20261020120000_replace_daily_puzzle_with_resolved_spar`
8. `20261020140000_default_legacy_bias_axes`

**Live database migration status is not confirmed.** This project status previously claimed all eight local migrations were applied, but the configured app database has since returned a missing `DailyPuzzleState` table error, and a fresh `prisma migrate status` check could not complete because the Windows Prisma schema engine failed to start. Treat square-bias, Daily Puzzle, and resolved-spar tables as unavailable until a successful status check confirms otherwise; do not infer deployment from local migration files.

## 6. Core analysis pipeline

### Game parsing and feature extraction

- `lib/lichess/fetchGames.ts` streams NDJSON, serializes requests process-wide, coalesces identical in-flight calls, uses a short in-memory cache, and retries one 429 after a wait.
- `lib/lichess/parseGame.ts` converts raw Lichess games into the app's `ParsedGame` shape.
- `lib/features/extractFeatures.ts` replays SAN with `chess.js` and derives per-ply mover/color, move number, clock spent/remaining, game phase, captures/checks/forcing moves, likely premoves, and snap decisions.
- `lib/eval/evalCache.ts` evaluates move sequences with Stockfish and stores/retrieves game results in browser IndexedDB. Quality checks detect incomplete or malformed cached evaluation sequences.
- Browser evaluation checkpoints each completed ply in IndexedDB and resumes that game from its last checkpoint on the next analysis load. Completed cached games whose server push failed are retried on a later analysis load.
- `lib/flags/causality.ts` checks whether a post-move eval deficit holds or recovers later in the game.
- `lib/flags/flagEngine.ts` combines eval loss, timing, severity, recurring-pattern and cascade rules to emit flags such as `collapse`, `pattern_repeat`, `tilt_cascade`, and `time_paradox`.
- `lib/flags/pivotMove.ts` provides on-demand MultiPV attribution for the opponent's preceding move; it is not part of the bulk eval sweep.
- `lib/profile/weaknessProfile.ts`, `lib/bias/updateBiasProfile.ts`, and profile update routines fold per-game data incrementally and track game IDs to avoid duplicate folds.

### Browser versus server costs

Stockfish and Maia computation is client-side. The server persists results but does not run a per-user engine fleet. This keeps compute off the application bill, but an analysis that never finishes in a loaded browser tab may remain unevaluated. The dashboard exposes evaluated/unevaluated counts; there is no background server evaluation queue.

## 7. Product surfaces

### `/` — live game analysis and spar (`components/board/GamePanel.tsx`)

- Loads the previous username when available and accepts username lookup/switching.
- Fetches recent live Lichess rapid games through `/api/games`.
- Reuses server-persisted flags/evaluation IDs for the signed-in user's own games and only runs browser evaluation on missing games.
- Pushes completed evaluation results to `/api/eval/push`; displays save/failure status.
- Shows verdict cards, supports dismissals (new dismissals are flag-type-specific while legacy IDs still suppress flags), jumps to a flagged ply, and can lazily load pivot attribution in the list or replay.
- Includes interactive replay/spar state with Maia and opponent-mimic mode, session IDs to prevent stale inference results, move/clock-aware delay behavior, and guarded attempt logging.
- Opponent data/profile loading is separate from the primary game fetch and uses client caches; Lichess rate limits mean some profile-building work is sequential.

### `/dashboard` — Spar home

- Selects the most recently dated flagged game and displays its worst flagged moment via Ghost Replay.
- Shows a queue of unresolved flagged plies; `ResolvedSparPosition` is the completion source, with legacy Daily Puzzle solves also honored.
- Queue links include `gameId` and `ply`, so the Ghost page opens that exact flagged ply. If `ply` is absent, Ghost Replay uses the game's worst flag; malformed or `>=600` query values are rejected.
- Links to Signature and Daily Puzzle.

### `/dashboard/signature`

- Holds the former player dossier (synced/evaluated game counts, phase timing, premove rate, opening repertoire, recurring patterns, recent flags, last sync) and embeds the Blind Spot Heatmap.
- Includes SyncPanel; initial dashboard load no longer runs sync as a blocking server request.

### `/dashboard/games` and `/dashboard/games/[gameId]`

- Paginated DB-backed archive, newest first, with opening/severity filters and per-move severity timeline.
- Saved-game review replays persisted moves/flags and offers a Ghost Replay entry.
- Displays the retrospective Ambient Pace Signal when the selected game contains a cascade that also appeared in at least two earlier games in the same opening and phase.
- Ambient Pace Signal is careful to say “cascade decline”; the cascade detector does not prove every move was below the player's usual pace.

### `/dashboard/games/[gameId]/ghost`

- Ghost Replay compares the recorded move, Stockfish top choice, and base Maia's behavioral prediction as three post-move positions.
- Stockfish evaluates each resulting position from the player's perspective, handles mate scores explicitly, and reports a played-vs-Stockfish delta when both scores are centipawns. Maia's move is labeled as a behavior prediction; its resulting position is evaluated by Stockfish.
- “Drill this position” opens PositionSpar at the pre-move FEN. The spar can offer base Maia or opponent mimic according to available tier signals.
- Ghost Progression generates two continuations up to six plies (three full moves) from the selected game position: Stockfish vs. Stockfish and Maia for the side to move (using that side's saved game-time rating) vs. Stockfish. After the user generates once, the lines update as they navigate through the game. Decisive evaluations are marked without truncating the line; generation ends at six plies or when the game position is over. It reuses `GameReplay` and `PositionSpar`, and caches PGN/FEN data in device-local IndexedDB. A synchronized full-game scrubber and open-ended branching continuation graph are not implemented.

### `/dashboard/openings` and `/dashboard/openings/[eco]`

- Opening Danger Score is a relative within-account ranking based on normalized average cp loss per own move, loss rate, and flag density; scores are not absolute predictions.
- Drill-down shows recurring player moves/positions in the first 14 plies and allows spar from a selected pre-move FEN. It chooses the worst high-severity flagged target for the opening.

### `/dashboard/patterns`

- Displays opening flag rates, phase-by-severity counts, accumulated weakness patterns, and spatial-bias data/status.
- Weakness pattern detection is intentionally coarse (phase buckets + sustained cp-loss candidates), not a tactical motif classifier.
- Phase/severity values are counts; the UI states they are not rates.

### `/dashboard/daily`

- Chooses an unresolved own flagged move whose side-to-move matches the user, reconstructs its pre-move position, and presents an interactive puzzle.
- The current client defaults to Stockfish's exact top move, with an opt-in toggle to accept one of its top five moves within 0.25 pawns of the best line. It then persists both the Daily Puzzle state and shared resolved-position marker. Skips remain in `DailyPuzzleState`; three skips defer a position, and a shorter skip cooldown is used before it is eligible again.
- This is a single best-move exercise, not a multi-line tactics trainer with a full solution tree.

### `/dashboard/rivalries` and `/dashboard/rivalries/[opponentUsername]`

- Lists opponents with repeated losses using the signed-in user's own game history.
- Detail shows W/L/D and streak, opponent-scoped openings, a flagged-destination distribution, effective-rating signal, and a spar target from the worst high-severity flagged position against that opponent.
- The rivalry heatmap uses persisted flagged moves only. Unflagged move counts and per-move timing for arbitrary opponent filtering are not retained, so it must not be described as a full blunder rate or time-pressure heatmap.

## 8. Maia and opponent mimicry

- `lib/maia/useMaiaWorker.ts`, `boardToTensor.ts`, `moveVocab.ts`, and `eloBuckets.ts` provide local Maia inference and move mapping.
- `lib/maia/rerank.ts` takes Maia logits and can adjust candidate move weights using opponent features, piece activity, opening tree, and time-pressure-related inputs; it includes a Stockfish safety check for selected boosted moves.
- Opponent profiles are built from the opponent's own recent Lichess games and cached in IndexedDB: opening choice tree, piece-activity tendencies, and time-pressure/collapse signals.
- Spar prewarms Maia/opponent profiles while the game is being inspected; playing remains opt-in.
- `resolveOpponentTier` currently gates effective mimic tiers on effective-rating history plus secondary data. Tier 1 requires effective-rating signal and opening-tree or piece-activity signal; Tier 2 requires effective rating and some secondary data; otherwise Tier 3. The exact tier coverage and user experience still need real-account validation.
- Ghost Replay's third comparison board is **base Maia**, not an opponent-specific mimic prediction. Opponent mimicry is engaged in the spar interaction, not in that comparison board.

## 9. API route inventory

| Route | Method | Purpose / source |
|---|---|---|
| `/api/auth/[...nextauth]` | GET/POST | Auth.js Lichess OAuth/session handlers. |
| `/api/sync` | POST | Authenticated incremental sync via `runSync`; supports explicit force behavior through its request handling. |
| `/api/games?username=...` | GET | Live Lichess games + derived profile; overlays saved flags/evaluation IDs for own account. |
| `/api/eval/push` | POST | Validates ownership/payload and transactionally persists eval, flags, and profile aggregates. |
| `/api/dashboard` | GET | Authenticated persisted dossier data. |
| `/api/dashboard/games?page=...` | GET | Authenticated paginated DB game archive. |
| `/api/patterns` | GET | Authenticated persisted pattern data. |
| `/api/openings` | GET | Authenticated opening danger aggregates. |
| `/api/bias` | GET | Authenticated square-bias/heatmap data. |
| `/api/puzzle/solve` | POST | Persists Daily Puzzle solve state and the shared resolved marker for an owned flagged ply. |
| `/api/puzzle/skip` | POST | Persists skip/cooldown/deferred state for an owned flagged ply. |
| `/api/spar/resolve` | POST | Persists a win/draw resolution for an owned flagged ply; it does not verify whether Stockfish assist was used. |
| `/api/opponent` | GET | Requires sign-in and recorded games against the named opponent, then fetches opponent features from Lichess. |
| `/api/opponent/effective-rating` | GET | Returns effective-rating signal from the signed-in user's recorded matchup history. |
| `/api/stockfish/[asset]` | GET | Serves/proxies engine assets used by browser evaluation. |

Several dashboard pages call the same server-side data functions directly rather than fetching their companion GET route. The routes still exist for API consumers.

## 10. Current unfinished work and limitations

### Validation and operations

- The configured database reported all eight migrations applied on 2026-10-22; re-check before a future release if the deployment target changes.
- Browser-check sync, evaluation save, archive review, Ghost Replay, spar, Daily Puzzle solve/skip, rivalry drill, and heatmap on a real account.
- Revisit historical game/profile backfill for square bias. Incremental profile folding does not itself guarantee old already-evaluated games were folded into newly introduced profile columns.
- There is no server-side eval queue, scheduled sync job, or SparSession persistence/resume. Eval recovery is local to the browser's IndexedDB; it does not run while the browser is closed or on another device.
- Because Ghost Progression adds on-demand browser-side Stockfish and Maia work, prioritize a resumable evaluation-queue design before increasing client compute or making generated lines a durable product record. No queue is being introduced in this pass.
- `package.json` provides a Playwright `test:e2e` command, but no unit-test command is defined; this handoff does not claim CI coverage.

### Product/analysis gaps

- Ghost Replay does not have a shared visual evaluation bar; it presents normalized per-position scores and the played-vs-Stockfish delta as text.
- Ghost Replay's full-game link opens the saved replay at the flagged move. The scrub position is URL-seeded, not persisted as a separate session.
- Ghost Replay's synchronized full-game scrub bar and open-ended branching continuations are deferred; its fixed six-ply progression lines are implemented and cached per device. Decisive positions are marked at the first decisive ply, but the line continues to six plies to satisfy the requested projection length.
- Opponent-specific mimic is partial and data-gated; its tier frequency and usefulness have not been validated across a broad sample. Keep it a secondary Spar option with honest availability copy until real-account tier coverage is measured; do not make it a primary product promise yet.
- Weakness patterns are coarse phase-level groupings, not tactical concepts such as forks or back-rank motifs.
- Some bias schema columns (`rankBias`, `fileBias`, `diagonalBias`) are present, but the current square-based updater is the source of truth; do not assume each legacy aggregate is independently produced or validated.
- `DailyPuzzleState` remains alongside `ResolvedSparPosition` because skip count, cooldown, and deferred status are Daily-Puzzle-specific. Daily Puzzle wins write both rows; other spar surfaces write the shared resolved marker on a win or draw.
- Personal progress already has a shared read path: `getSparQueue` unions solved Daily Puzzle keys with spar-resolution keys for the resolved count and unresolved queue. Keep that personal progress display unified while retaining the separate Daily Puzzle scheduling state; no schema merge is currently needed.
- Resolved-position integrity remains personal-only and client-nudged. Do not surface resolved counts as a public trust or rivalry signal without moving assist-use enforcement server-side.
- Spar resolution records successful wins and draws, not losses or incomplete sessions. It does not persist a full SparSession or move history. The spar UI skips resolution after displaying a Stockfish hint, but this is a client-side honesty nudge, not server-enforced integrity; the API can still be called directly.
- Scout Report stays blocked until there is a consent/privacy policy for profiles of named third parties. Persona Gauntlet, if pursued, must use fictional personas rather than real public figures. Mirror Match is explicitly parked until server-side evaluation and mid-session re-profiling exist.

## 11. Working-tree and validation note

On 2026-10-22, `npx tsc --noEmit`, `npm run lint`, and `npm run build` passed. `npx prisma migrate status` reported the configured database up to date with all eight migrations; no migration was applied during the check. The `ResolvedSparPosition` P2021 catch is fallback behavior and did not trigger in that environment. No real-account browser walkthrough has been completed.

## 12. Recommended next actions for the governing agent

1. Browser-validate core data flow: sync and evaluate a game, confirm save status and archive reads, then test resolved spar wins/draws and Daily Puzzle solve/skip behavior.
2. Measure mimic-tier coverage on real accounts before increasing its UI prominence.
3. Scope the resumable server-side evaluation queue before expanding browser-side compute further.
4. Measure mimic-tier coverage on a real account before using broad claims about opponent-mimic availability. Keep the open-ended Ghost continuation graph and SparSession persistence as separate work; browser-validate fixed-length Ghost Progression and its local cache.
5. Only after this baseline is verified, proceed with larger visual redesign work.
