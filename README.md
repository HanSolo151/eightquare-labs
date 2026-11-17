# EightSquare Labs

EightSquare Labs is a full-stack chess review and training application for Lichess players. It imports a player’s games, evaluates positions with Stockfish, identifies costly or unusual decisions, turns recurring signals into a personal chess profile, and provides practical replay, puzzle, and sparring experiences.

The application is intentionally hybrid:

- **Lichess** is the source of account and game data.
- **PostgreSQL** is the durable, account-scoped archive.
- **Stockfish** performs position evaluation in the browser for live review and on the server for a limited background queue.
- **Maia** runs in the browser to provide human-like move predictions and sparring behaviour.

> This repository contains a working product codebase with analysis experiments and operational scripts. Some advanced features—particularly opponent mimicry and the prototype-player model—are data-gated and should be treated as experimental until validated with representative accounts.

## What it does

- Sign users in through Lichess OAuth and securely persist encrypted OAuth tokens.
- Synchronize up to 500 recent Lichess games into a per-user PostgreSQL archive.
- Review recent rapid games directly from Lichess and evaluate missing games in the browser.
- Store completed evaluations, flagged moves, player-profile aggregates, and board-square bias data.
- Surface a dashboard with a game archive, signature/dossier, openings, patterns, rivalries, Daily Puzzle, wins analysis, and Ghost Replay.
- Let a player replay a critical moment, compare their move with Stockfish and Maia, then drill the position through an interactive spar session.
- Build an optional opponent-style profile from public Lichess history and use it to adjust Maia candidates when enough signal is available.

## Architecture

```mermaid
flowchart LR
  L["Lichess\nOAuth + game APIs"] --> N["Next.js routes\nand sync service"]
  N --> P[("PostgreSQL\nvia Prisma")]
  L --> R["Live game review\nin the browser"]
  R --> S["Stockfish WASM\n+ Maia ONNX"]
  S --> C[("IndexedDB\nlocal checkpoints")]
  S -->|"completed evaluations and flags"| N
  P --> D["Authenticated dashboard\nand saved-game review"]
  P --> Q["Background evaluation queue"]
  Q --> E["Server-side Stockfish"]
```

### Why two analysis paths?

The root review screen (`/`) is optimized for immediately inspecting Lichess games. It can run a deeper browser-side Stockfish pass (depth 16), checkpoint progress in IndexedDB after each ply, and retry a failed upload later from the same browser.

The durable archive is optimized for account-owned features. A sync writes `Game` rows to PostgreSQL and enqueues eligible rated wins for the background evaluator. The scheduled worker evaluates those jobs server-side at depth 10, checkpoints work, and persists results for dashboard pages. It is deliberately a limited queue—not a full server-side evaluator for every imported game.

## Product areas

| Area | Path | Purpose |
| --- | --- | --- |
| Live review | `/` | Fetch recent rapid games for a Lichess username, evaluate them, and inspect move-level flags. |
| Dashboard home | `/dashboard` | Shows the next unresolved critical moment and spar queue. |
| Signature | `/dashboard/signature` | Player dossier: games, timing, openings, recurring patterns, and square-bias heatmap. |
| Game archive | `/dashboard/games` | Persisted, paginated game history with opening and severity filtering. |
| Saved review | `/dashboard/games/[gameId]` | Replays moves, flags, and severity timeline from the archive. |
| Ghost Replay | `/dashboard/games/[gameId]/ghost` | Compares played, Stockfish, and Maia continuations; opens a spar drill. |
| Openings | `/dashboard/openings` | Ranks account-specific opening danger and provides a drill-down. |
| Patterns | `/dashboard/patterns` | Aggregates timing/evaluation flags, recurring weaknesses, and spatial bias. |
| Daily Puzzle | `/dashboard/daily` | Creates a single-move exercise from an unresolved flagged position. |
| Rivalries | `/dashboard/rivalries` | Highlights repeated opponents, scores, openings, and drill targets. |
| Wins | `/dashboard/wins` | Compares saved wins against the optional player-style library. |

## Analysis pipeline

1. **Fetch and parse games.** `lib/lichess/fetchGames.ts` requests Lichess game exports; `lib/lichess/parseGame.ts` converts them to the app’s game shape.
2. **Synchronize account history.** `POST /api/sync` calls `lib/sync/runSync.ts`, inserts only the signed-in user’s `Game` rows, catches up on recent games, then backfills history in bounded batches.
3. **Evaluate positions.** Browser review uses the Stockfish worker and stores partial results in IndexedDB. Eligible sync jobs can also be evaluated by the scheduled server queue.
4. **Extract signals.** `lib/features/extractFeatures.ts` derives move timing, phases, captures, checks, premoves, and related context from the replay.
5. **Flag critical moves.** `lib/flags/flagEngine.ts` combines centipawn loss, timing deviations, causality, recurrence, and cascade rules. Examples include collapses, repeated patterns, tilt cascades, and time paradoxes.
6. **Persist and aggregate.** `POST /api/eval/push` validates ownership and stores evaluations, flags, profile aggregates, weakness patterns, and square bias transactionally.
7. **Turn findings into practice.** Dashboard pages choose unresolved positions for Ghost Replay, Daily Puzzle, opening drills, and spar sessions.

### Important interpretation limits

- A flag is a review prompt, not proof that a move was objectively bad for every practical purpose.
- Opening Danger Score is a ranking within one account, based on normalized loss, result, and flag signals—not an absolute opening strength metric.
- Weakness patterns are coarse phase/tendency groupings, not confirmed tactical motifs.
- Maia predicts plausible human moves; it is not an engine and its comparison board is not opponent-specific mimicry.
- Rivalry heatmaps use persisted flagged moves. They do not represent a full blunder-rate or timing distribution for every opponent move.

## Technology

- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4
- Auth.js / NextAuth v5 beta with custom Lichess OAuth
- Prisma 6 and PostgreSQL
- `chess.js` for legal replay and Chessground for boards
- Stockfish 19 and browser Web Workers
- Maia ONNX models through `onnxruntime-web`
- Playwright for end-to-end checks

## Local setup

### Prerequisites

- Node.js 20 or newer
- npm
- A PostgreSQL database
- A Lichess OAuth application with a local callback URL

### Install and configure

```bash
git clone https://github.com/HanSolo151/eightquare-labs.git
cd eightquare-labs
npm ci
```

Create `.env` from the following template. Keep it out of version control.

```dotenv
# Prisma/PostgreSQL
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public"
# Use a direct, migration-capable connection when DATABASE_URL is pooled.
DIRECT_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public"

# Auth.js and Lichess OAuth
AUTH_SECRET="generate-a-long-random-secret"
LICHESS_CLIENT_ID="your-lichess-oauth-client-id"

# Required only for the scheduled evaluation endpoint
CRON_SECRET="another-long-random-secret"
```

In your Lichess OAuth application, register this callback URL for local development:

```text
http://localhost:3000/api/auth/callback/lichess
```

Create the local database schema and generated Prisma client:

```bash
npx prisma migrate dev
npx prisma generate
```

Start the application:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with Lichess, then use the dashboard’s sync action to import games.

### Deploying

Set the same environment variables in the deployment environment, change the Lichess callback URL to the deployed `/api/auth/callback/lichess` endpoint, apply Prisma migrations, and configure a scheduler for:

```text
GET /api/cron/vanity-evaluations
Authorization: Bearer $CRON_SECRET
```

`vercel.json` configures this endpoint to run every five minutes on Vercel. Each invocation processes up to eight jobs or stops after roughly four minutes.

## Security and account boundaries

- The durable identity is Lichess’s stable account ID; usernames are display values and may change.
- OAuth access and refresh tokens are encrypted with an AES-GCM key derived from `AUTH_SECRET` before being stored.
- All dashboard reads, game mutations, puzzle state, and spar resolutions are scoped to the authenticated internal user ID.
- Auth sessions are JWT-based. `AUTH_SECRET_PREVIOUS` can be supplied temporarily during a secret rotation; run `npm run rotate:oauth-tokens` while both secrets are present, then remove the old secret after successful rotation.

## Data model

The Prisma schema in `prisma/schema.prisma` defines the main entities:

| Model | Responsibility |
| --- | --- |
| `User` | Stable Lichess identity, encrypted tokens, sync watermarks, plan metadata. |
| `Game` | Account-scoped Lichess game data, moves, clocks, opening data, and results. |
| `GameEval` | Per-ply Stockfish evaluation points for one saved game. |
| `FlaggedMove` | Timing/evaluation anomaly, severity, causality, and explanation at a ply. |
| `PlayerProfile` / `WeaknessProfileRow` | Account-level timing, opening, and recurring-pattern aggregates. |
| `BiasProfile` | Square-level behavior bias and idempotent fold metadata. |
| `DailyPuzzleState` | Puzzle skips, cooldowns, and deferred status. |
| `ResolvedSparPosition` | Shared completion marker for solved/drilled positions. |
| `VanityEvaluationJob` | Leaseable, retryable background evaluation jobs. |
| `Bigshot` and related models | Reference-player/style-library profiles and sample games. |

Games are unique per `(userId, lichessGameId)`, which allows a shared Lichess game to be held by more than one account without mixing ownership.

## API overview

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/auth/[...nextauth]` | GET, POST | Lichess OAuth and Auth.js handlers. |
| `/api/sync` | POST | Incremental account-scoped Lichess sync and bounded history backfill. |
| `/api/games?username=…` | GET | Live Lichess games for review; overlays saved state for the signed-in owner. |
| `/api/eval/push` | POST | Validates and persists completed browser analysis. |
| `/api/dashboard` | GET | Persisted signature/dashboard data. |
| `/api/dashboard/games` | GET | Paginated game archive. |
| `/api/openings`, `/api/patterns`, `/api/bias` | GET | Persisted account analytics. |
| `/api/puzzle/solve`, `/api/puzzle/skip` | POST | Daily Puzzle state changes. |
| `/api/spar/resolve` | POST | Marks an owned flagged position resolved. |
| `/api/opponent`, `/api/opponent/effective-rating` | GET | Opponent profile and tier signals. |
| `/api/stockfish/[asset]` | GET | Serves browser Stockfish assets. |
| `/api/cron/vanity-evaluations` | GET | Protected scheduled queue processor. |

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start Next.js in development mode. |
| `npm run build` / `npm run start` | Build and run the production application. |
| `npm run lint` | Run ESLint. |
| `npx tsc --noEmit` | Type-check the TypeScript codebase. |
| `npm run test:e2e` | Run Playwright tests; starts the local server automatically. |
| `npm run test:sync-verify` | Run sync verification with local fakes. |
| `npm run test:flag-engine` | Exercise flagging logic. |
| `npm run test:matching-unit` | Test player-style matching units. |
| `npm run test:matching-gates` | Test mimic/matching eligibility gates. |
| `npm run test:reranker` | Test Maia candidate reranking. |
| `npm run test:sacrifice-detector` | Test sacrifice detection. |
| `npm run convert:bigshots` / `npm run ingest:bigshots` | Prepare and ingest the reference-player corpus. |
| `npm run rebuild:flags` | Recalculate persisted flags. |
| `npm run rotate:oauth-tokens` | Re-encrypt stored tokens during `AUTH_SECRET` rotation. |

The repository also contains diagnostic scripts under `scripts/` for Stockfish quality, flag stability, matching, candidate coverage, evaluation queues, and corpus ingestion. They are operational/development tools and may require a configured database or local artifacts.

## Tests

Run the fast checks that are available in the repository:

```bash
npm run lint
npx tsc --noEmit
npm run test:sync-verify
npm run test:e2e
```

The Playwright suite includes a signed-out access test. Authenticated scenarios are skipped unless `E2E_STORAGE_STATE` points to a local Auth.js browser storage-state file.

## Maia and style matching

The shipped browser models live in `public/models/`. Base Maia is rating-conditioned and runs entirely in the browser. Opponent mimicry adds features such as effective rating, opening tendencies, piece activity, and time-pressure signals, then may rerank legal Maia moves while applying a Stockfish safety check.

The optional Python pipeline under `scripts/player_model/` can prepare a prototype corpus, fine-tune player embeddings, and export ONNX files. See [scripts/player_model/README.md](scripts/player_model/README.md) for its separate Python requirements, data constraints, and training instructions. The checked-in app remains usable without trained prototype artifacts.

## Reference-player data and licensing

Historical PGN inputs for the “bigshots” corpus must be sourced and attributed before ingestion. Add source information to `config/bigshots.json` and read [data/bigshots/README.md](data/bigshots/README.md) before importing material. Do not commit private game exports, generated corpora, model checkpoints, or unreviewed licensed data.

## Repository map

```text
app/                    Next.js pages and route handlers
components/             Boards, review surfaces, dashboard UI
lib/                    Auth, Lichess, evaluation, flags, profiles, and analysis logic
prisma/                 Database schema and migrations
public/models/          Browser Maia ONNX models and manifests
scripts/                Maintenance, diagnostics, ingestion, and model-training tools
e2e/                    Playwright end-to-end tests
config/                 Matching and reference-player configuration
artifacts/evaluation/   Checked-in evaluation reports and diagnostics
```

## Current caveats

- Browser analysis checkpoints are device-local until their completed result uploads successfully.
- Closing the tab halts active client-side evaluation.
- The server evaluation queue only covers eligible work and needs operational monitoring for terminal failures.
- Opponent mimic tiers depend on enough public Lichess history and are not guaranteed to be available.
- Some dashboard metrics are deliberately relative/proxy metrics; preserve those qualifications when extending the product.

For a detailed implementation handoff, feature-level behavior, and known validation work, see [PROJECT_STATUS.md](PROJECT_STATUS.md).
