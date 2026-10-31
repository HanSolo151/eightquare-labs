# Flag depth-stability diagnostic

Generated 2026-10-31T22:13:14.126Z. Full census: 64/64 persisted flags re-evaluated at depth 22 using full Stockfish 19 single-threaded WASM.

This compares search stability, not human-label accuracy. Cascades are re-evaluated as the sum of their constituent own-move eval swings. A position is tagged multiple comparable options when the top-1 versus top-2 MultiPV score gap is below 30 cp. Mate transitions are included on the same synthetic 10,000 cp scale used in production and are marked per row.

| Group | n | Confirmed | Downgraded | Reversed |
|---|---:|---:|---:|---:|
| depth:depth16 | 64 | 55 (85.9%) | 7 (10.9%) | 2 (3.1%) |
| depth:depth8-9 | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |
| depth:other | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |
| overall | 64 | 55 (85.9%) | 7 (10.9%) | 2 (3.1%) |
| exact-depth:16 | 64 | 55 (85.9%) | 7 (10.9%) | 2 (3.1%) |
| stratum:high | 39 | 33 (84.6%) | 4 (10.3%) | 2 (5.1%) |
| phase:opening | 9 | 9 (100.0%) | 0 (0.0%) | 0 (0.0%) |
| stratum:low | 9 | 6 (66.7%) | 3 (33.3%) | 0 (0.0%) |
| phase:middlegame | 25 | 22 (88.0%) | 2 (8.0%) | 1 (4.0%) |
| stratum:cascade | 13 | 13 (100.0%) | 0 (0.0%) | 0 (0.0%) |
| phase:endgame | 30 | 24 (80.0%) | 5 (16.7%) | 1 (3.3%) |
| stratum:medium | 3 | 3 (100.0%) | 0 (0.0%) | 0 (0.0%) |

Multiple comparable options (<30 cp top-1/top-2 gap): 26/64 (40.6%).

Projected severity labels from the full-census original cpLoss values under the 150cp medium floor (diagnostic only): {"low":9,"medium":3,"high":52}.

### Stability around the low-tier boundary

| Original cpLoss | n | Confirmed at depth 22 | Downgraded | Reversed |
|---|---:|---:|---:|---:|
| 100-149cp | 9 | 6 (66.7%) | 3 (33.3%) | 0 (0.0%) |
| 150-200cp | 3 | 3 (100.0%) | 0 (0.0%) | 0 (0.0%) |

## Persisted depth inventory

Actual evaluation depths at each persisted flag ply, grouped by stored engine version:

| Engine version | Actual depth | Flags |
|---|---:|---:|
| stockfish-19-lite-single-depth16-target-v3 | 16 | 30 |
| stockfish-19-lite-single-depth16-v2 | 16 | 34 |

Full census CSV: flag-depth-stability-full.csv
