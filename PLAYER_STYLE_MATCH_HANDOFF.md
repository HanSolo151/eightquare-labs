# Player-style matching handoff

Updated: 2026-10-23

## Current state (2026-10-24)

The production database now contains all **30 configured player profiles** at Stockfish depth 10, plus full-roster phase calibrations. The wins-only ingestion selected up to 375 games per player (Reti's configured exception selected 280). Every player cleared the unchanged 250-usable-vector floor in every phase. Reti is closest to the floor at **280 / 279 / 254** opening/middlegame/endgame vectors.

The full-roster matcher dry run is at [artifacts/profile-matcher-dry-run.json](./artifacts/profile-matcher-dry-run.json). It reports `ready_for_human_review`, exactly 30 names and 90 phase profiles, but analyzed only **2** eligible recent user wins. Treat that as limited validation, not a quality conclusion. The operator has accepted shipping with this gap; §6 remains open and should be revisited once real usage provides more eligible games to review. No email was sent during the ingestion/dry-run work.

An orphaned concurrency-test fixture appeared in the first dry run. Its exact synthetic user had one test game, three test moments, and no email sends; that user and its synthetic bigshot were removed. The report was rerun and now contains only the configured roster.

The vector sampling fix remains in place: vectors use all of the player's own moves in each phase, independently of `FlaggedMove`, which remains unchanged for weakness coaching.

### Historical initial validation state

Before the full corpus run, the production DB held only Tal, Karpov, and Carlsen at depth 10, with phase counts Tal 375/375/363, Karpov 375/374/372, and Carlsen 375/375/368. Those profiles were replaced/upserted as part of the full-roster publication. The earlier three-player dry-run result is superseded by the current full-roster report.

## Shipping decision and post-ship follow-up

The release decision is to ship as-is with a limited validation sample (2 games). This known §6 match-quality gap is accepted and does not block shipping. Revisit it once real usage produces more eligible games to review. Do not mark §6 cleared without that review. Future tuning of dimensions, thresholds, or corpus should follow real usage evidence, not precede it. The production corpus is published, but this workspace has no Git remote or linked Vercel project; a hosted application deployment was not triggered or verified here.

Final local checks passed: production build, ESLint, TypeScript, and the database-backed rerank concurrency test. The test now targets only its own synthetic user, uses separate games for distinct send candidates, deletes its fixture rows transactionally, cleans stale reserved-prefix fixtures at startup, and releases the send gate on SIGINT/SIGTERM. Post-test verification found no remaining synthetic fixture rows.

## After the human review

1. Review the two examples in the current full-roster dry-run report. The small user-game sample prevents a strong accuracy conclusion.
2. If the closest-player ordering looks plausible, monitor more eligible imported wins and collect feedback. The current forward-only queue policy does not backfill old games; expanding historical coverage requires a separate explicit decision.
3. If matches look weak, inspect phase-vector distributions and top-three distance gaps before changing dimensions or thresholds. Keep the 250-per-phase floor and 375-win cap unless the operator directs otherwise.
4. The current depth-10 30-player corpus is the active baseline. Any depth-16 rebuild or roster/source change needs a new runtime estimate and an explicit run plan.
5. Do not send emails or mark the §6 checkpoint cleared as part of a dry run. Emails remain opt-in and capped at two per rolling seven days.

The current matcher supports broad phase-style resemblance and representative game labels. It cannot substantiate an exact claim such as “you played this same line as Tal”; that requires a separate move-sequence/repertoire matcher.

## Commands and verification

From `D:\Chess\eightsquare-labs`:

```powershell
npm exec tsx -- scripts/test-profile-matcher.ts 50 --validation
npm run test:matching-unit
npm run test:ingest-bigshots-smoke
npm run test:matching-gates
npm run test:matching-rerank
npm exec tsc -- --noEmit
```

Verified after the sampling correction: TypeScript, ESLint on changed files, matching unit/gate/rerank checks, and ingestion smoke test passed.

## Reference files

- [PLAYER_STYLE_MATCH_STATUS.md](./PLAYER_STYLE_MATCH_STATUS.md) — project checkpoint and implementation notes.
- [config/matching.ts](./config/matching.ts) — depth settings, validation names, and unchanged corpus thresholds.
- [lib/matching/computeGameVector.ts](./lib/matching/computeGameVector.ts) — all-move phase vector sampling.
- [scripts/ingest-bigshots.ts](./scripts/ingest-bigshots.ts) — validation-only and full ingestion paths.
- [scripts/test-profile-matcher.ts](./scripts/test-profile-matcher.ts) — dry run with optional validation profile scope.
- [artifacts/profile-matcher-dry-run.json](./artifacts/profile-matcher-dry-run.json) — latest scoped dry-run output.

## Build continuation update

Saved-game review now includes a compact player-style panel alongside the replay and flagged-move analysis. It displays the closest stored match, or a state for ineligible, pending, completed without a match, or failed analysis. This reads the existing per-game `GameMoment` and `VanityEvaluationJob` records and needs no migration.

The email delivery flow limits each user to two sends per rolling seven-day window and requires opt-in. `vanityMatchOptIn` defaults to false; sync and queue paths do not create preferences or enroll users. Delivery queries only preferences with `vanityMatchOptIn: true` and a configured email address. No email was sent for the UI work.

The dry-run worked example now identifies its representative move as illustrative and states that the associated vectors and diagnostics summarize all of the player's moves in that phase.

## Latest continuation update (2026-10-23)

The saved-game style panel now labels the representative source game (event/year/player headers when present) for each phase match. The panel copy says the match is a broad phase-style resemblance and does not claim an identical opening line or playing strength. Weekly email includes the same representative-game label and remains opt-in, capped at two per rolling seven days. This improves traceability but the five-dimensional matcher still cannot substantiate a claim such as "you played the same line as Tal"; exact opening-line comparison would require a separate move-sequence/repertoire matcher.

Historical scan of the ten added files: Ding 734, Shirov 2,906, and Spassky 714 clear 350 wins; Reti has 280. The current roster uses Ding, Reti, Shirov, and Spassky, with Reti's explicit 250-win minimum. See the latest corpus plan below.

That earlier roster and 119-hour estimate are superseded. The latest update below defines the exact-30 roster, Reti exception, 264-hour estimate, and full-corpus staging workflow.

## Corpus roster and staged-run plan

The preceding depth-16 plan is superseded by the operator's decision to use depth 10 for the first complete 30-player corpus. Current roster, measured runtime, exact commands, and run status are recorded in the depth-10 update below.

## Depth-10 roster run (2026-10-23)

The operator chose depth 10 for the first full 30-player corpus because depth 16 is disproportionate to this feature. `config/matching.ts` sets corpus depth to 10. The 80-position local benchmark measured depth 10 at 168.83 positions/second, estimating about **1.58 serial hours** for 960,087 positions before overhead; depth 16 measured about 263.92 hours. The earlier Reti depth-16 attempt was interrupted before its stage was written. The complete depth-10 staging and publication finished successfully on 2026-10-24; all 30 passed all phase floors. The dry run was rerun after removing the orphaned test fixture and now reports 30 players / 90 profiles and 2 analyzed user wins.

Run the resumable full-roster evaluation with:

```powershell
npm run ingest:bigshots:staged -- --stage-all
npm run ingest:bigshots:staged -- --publish-staged
```

Each completed player is saved locally under ignored `artifacts/bigshot-staging/`; if interrupted, rerun `--stage-all` and completed stages are skipped. Do not use `--replace-staged` unless a stage is stale or intentionally recomputed. Publishing checks all 30 files and the unchanged 250-per-phase floor before the only database write.
