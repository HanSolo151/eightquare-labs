# Player-style analysis: current status

Updated: 2026-10-24

## Current build

The dashboard has a **Wins** tab. It lists the signed-in user's saved wins; selecting an evaluated win computes the player's phase vectors and nearest bigshot matches in the browser. The client shows opening, middlegame, endgame, an overall nearest-style result, phase descriptions, and estimated move quality by phase. Where clock data and a complete saved evaluation exist, it compares evaluated moves made with low remaining time against moves made with more time.

Only the authenticated user's wins and their saved evaluations are passed to the client. The server supplies the compact 30-player profile vectors and calibration. Style matching runs on demand in the client and does not write a match result to the database. The existing game-evaluation queue still computes and stores Stockfish evaluations and coaching flags for newly imported rated wins; the Wins tab reuses those saved evaluations. Older wins without complete evaluations show a clear unavailable state.

Time-pressure text is an estimate from remaining clock and engine evaluation change for that move. It is shown only when enough evaluated, clock-tagged moves exist. Results describe the selected win, not durable playing strength. The phase comparison is broad resemblance, not an identical line claim.

The email feature has been removed from the source app: delivery code, preference UI/API, unsubscribe and token pages, feedback link API, email cron, email-related configuration, and email database models are gone. `vercel.json` keeps only the game-evaluation cron. Migration `20261024130000_remove_player_match_email` drops the old match/email tables. **The migration is not applied yet.** This workspace has no Git remote or linked Vercel project, so the app has not been deployed; an existing hosted deployment may continue running its old email cron until the updated app is deployed and the migration is applied.

## Corpus

- Production currently has profiles for the 30 configured players and one calibration per phase.
- Corpus evaluation depth: Stockfish 19 lite-single, depth 10.
- Each profile cleared the unchanged 250-usable-vectors-per-phase floor. Richard Reti is closest at 280/279/254 (opening/middlegame/endgame).
- The corpus remains wins-only, capped at 375 games per player; Reti has the previously approved 250-win ingestion exception.
- The last real dry run had exactly 30 names / 90 phase profiles and two eligible user wins. Treat this as limited validation; revisit match quality once real usage provides more eligible games.

## Implementation references

- `app/dashboard/wins/page.tsx` — authenticated, paginated win list and compact profile data.
- `components/dashboard/WinsAnalysis.tsx` — browser-side vector computation, matching, phase descriptions, and clock/evaluation summaries.
- `lib/matching/computeGameVector.ts` — shared five-dimensional vector computation.
- `config/bigshots.json` — active 30-player corpus roster.
- `prisma/migrations/20261024130000_remove_player_match_email/migration.sql` — pending legacy table cleanup.

## Final local checks

- `npm exec prisma -- validate` — passed.
- `npm exec prisma -- generate` — passed.
- `npm run build` — passed.
- `npm run lint` — passed.
- `npm exec tsc -- --noEmit` — passed.
