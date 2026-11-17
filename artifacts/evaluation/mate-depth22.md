# Mate-transition depth-stability diagnostic

Generated 2026-11-05T04:26:10.105Z. Mate-backed flags re-evaluated: 13/13 at depth 22 using full Stockfish 19 single-threaded WASM.

This compares search stability, not human-label accuracy. Mate scores are reported as signed mate distances, and cp columns are null whenever either evaluation is mate-backed; no mate-to-cp conversion is included in the report.

| Group | n | Confirmed | Downgraded | Reversed |
|---|---:|---:|---:|---:|
| depth:depth16 | 13 | 11 (84.6%) | 2 (15.4%) | 0 (0.0%) |
| depth:depth8-9 | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |
| depth:other | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |
| overall | 13 | 11 (84.6%) | 2 (15.4%) | 0 (0.0%) |
| exact-depth:16 | 13 | 11 (84.6%) | 2 (15.4%) | 0 (0.0%) |
| stratum:high | 13 | 11 (84.6%) | 2 (15.4%) | 0 (0.0%) |
| phase:middlegame | 4 | 4 (100.0%) | 0 (0.0%) | 0 (0.0%) |
| phase:endgame | 9 | 7 (77.8%) | 2 (22.2%) | 0 (0.0%) |

Multiple comparable options (<30 cp top-1/top-2 gap): 1/2 (50.0%).

### Stability around the low-tier cp boundary

| Original cpLoss | n | Confirmed at depth 22 | Downgraded | Reversed |
|---|---:|---:|---:|---:|
| 100-149cp | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |
| 150-200cp | 0 | 0 (n/a) | 0 (n/a) | 0 (n/a) |

## Persisted depth inventory

| Engine version | Actual depth | Flags |
|---|---:|---:|---:|
| stockfish-19-lite-single-depth16-target-v3 | 16 | 30 |
| stockfish-19-lite-single-depth16-v2 | 16 | 34 |

Report CSV: mate-depth22.csv
