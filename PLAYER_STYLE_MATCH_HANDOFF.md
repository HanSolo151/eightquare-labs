# Player-style analysis handoff

Updated: 2026-10-24

## Product behavior

Use `/dashboard/wins` to select a saved win. A small browser-side computation reuses that game's saved moves/evaluation plus the existing 30-player phase vectors. It reports the closest player by phase and an overall nearest style, describes a few measured characteristics, and summarizes estimated evaluation drops by phase and clock-pressure group. The selected game's comparison is scheduled first after initial paint; other evaluated games on the current page are prepared one at a time during browser idle time.

The client does not run Stockfish or fetch external data. The existing server-side evaluation worker remains responsible for generating saved move evaluations/flags on newly imported rated wins; the style vector and match comparison run in the browser when the user selects a game. Older wins without a complete evaluation are listed but cannot yet get a calibrated style comparison. Clock-pressure observations require clock tags and enough evaluated moves.

## Email removal

Email delivery, preferences, cron route, unsubscribe/token pages, and email feedback handling have been removed from the source. New source no longer has an email sender or schedule. `vercel.json` retains only the five-minute game-evaluation cron.

Prisma no longer models the old stored match/email tables. Migration `20261024130000_remove_player_match_email` drops those tables. **Do not treat the hosted application as updated yet:** this checkout has no Git remote or Vercel project link, and the migration has not been applied. The currently hosted build may still have the old email cron until code is redeployed. After a deployment target is connected, deploy the updated app and apply the pending Prisma migration in the agreed order; then verify the old email endpoint/cron is gone.

## Current data and known limit

The production DB contains 30 depth-10 player profiles and phase calibrations. Every player passed the 250-per-phase floor; Reti's lowest phase count is 254. The corpus remains wins-only and capped at 375 selected wins per player.

The last dry run covered only two eligible user wins. This is accepted as a limited validation sample; revisit match quality when actual usage provides more evaluated wins. Keep future dimension, threshold, and corpus tuning grounded in that usage.

## Checks completed

- Prisma schema validation and client generation passed.
- Production build passed.
- ESLint passed.
- TypeScript passed.

No email was sent during this implementation. No test suite was run for this UI change.
