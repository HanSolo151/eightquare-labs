# Maia player embeddings

This optional pipeline learns one embedding per prototype player while freezing
the pretrained Maia-2 backbone. It also trains a GRU-based prototype matcher
from profiles spanning multiple games. Training data may be plain PGN files or
ZIP archives containing PGNs.

The checked-in app model remains rating-conditioned until trained artifacts are
installed. No game archives, checkpoints, embeddings, or ONNX exports are
committed by this pipeline.

## Environment

Use Python 3.10-3.12 in a separate environment. To prepare PGNs only, install
the lightweight parser:

```powershell
python -m pip install -r scripts/player_model/requirements-data.txt
```

For model training and ONNX export, install:

```powershell
python -m pip install -r scripts/player_model/requirements.txt
```

`maia2` installs its supported PyTorch stack. Training uses CUDA when available;
pass `--device cpu` or `--device cuda` to select explicitly. The first model
load may download Maia-2's pretrained Rapid checkpoint.

## Collect and train the prototype corpus

The Lichess collector builds a roster of 15 prototypes in each of eight Rapid
rating bins and downloads 100 rated Rapid games per selected player (12,000
games total). It discovers candidates from the Rapid leaderboard and recent
started or finished Rapid arenas, samples recent game histories for a few
candidates in each bin, and expands the pool with historical Rapid arenas. It
then verifies each account's current Rapid rating and available Rapid-game
count before downloading. Candidate discovery is a pool, not a guarantee that
every bin can be filled; add arena IDs to a text file or usernames to a text
file if a rating bin is short.

```powershell
python -m pip install -r scripts/player_model/requirements-data.txt
python -m scripts.player_model.collect_lichess `
  --discover-only `
  --tournament-limit 25 `
  --participants-per-tournament 5000
python -m scripts.player_model.collect_lichess `
  --output-dir data\player_model\prototypes `
  --players-per-bin 15 `
  --games-per-player 100 `
  --tournament-limit 25 `
  --participants-per-tournament 5000
```

Optional `--tournament-ids-file` and `--candidate-usernames` files can expand
discovery. The collector spaces requests by at least one second, honors
Lichess's 429 retry delay, skips accounts with insufficient rated Rapid games,
and writes `prototype_roster.json` only after all quotas are met. Historical
discovery is bounded by `--history-seed-players-per-bin` (default 3) and
`--history-tournament-limit` (default 50). PGNs and downloads stay local and
are not committed.

Train against exactly the roster order used for the collected PGNs:

```powershell
python -m scripts.player_model.train `
  --data-dir data\player_model\prototypes `
  --roster-manifest data\player_model\prototypes\prototype_roster.json `
  --maia-model-dir D:\Chess\maia\maia2_models `
  --output-dir artifacts\player_model `
  --max-games-per-player 100
```

By default, Maia trains for up to 15 epochs with cosine annealing, fine-tuning
the player embeddings and the final CNN residual block. Training stops after
three epochs without validation top-1 improvement and restores the best
validation-top-1 checkpoint. The PMN uses sliding 20-game profiles, ignores
each player's moves before ply 12, applies 0.5 dropout, and uses `1e-4` weight
decay. Game order within each training profile is shuffled as augmentation;
the PMN also restores its best validation-accuracy checkpoint and uses the
same patience. At inference it aggregates each player's moves from 20–50
recent rated Rapid games; it does not classify an opponent from only the
current replay game.

## Prepare and train local samples

Start with five local prototypes and bounded samples:

```powershell
python -m scripts.player_model.train `
  --data-dir D:\Chess\maia\chess_pgn_zips `
  --maia-model-dir D:\Chess\maia\maia2_models `
  --output-dir artifacts\player_model `
  --max-players 5 `
  --max-games-per-player 100 `
  --max-positions-per-player 10000
```

To prepare one prototype's train/validation JSONL without loading PyTorch:

```powershell
python -m scripts.player_model.train `
  --data-dir D:\Chess\maia\chess_pgn_zips `
  --output-dir artifacts\player_model `
  --players Carlsen `
  --max-players 1 `
  --prepare-only
```

For a single-player embedding training run, omit `--prepare-only` and add
`--players Carlsen --max-players 1`. A one-player manifest intentionally has no
PMN classifier; the browser selects ID 0 only when the opponent username exactly
matches that prototype name.

Each prototype is split by whole games to prevent positions from the same game
leaking across train and validation. Black-to-move positions and UCI labels are
mirrored into Maia's canonical White-to-move orientation. The data manifest
records game and position counts; inspect it before running a full training job.

The trainer reports held-out legal-move top-1 accuracy, aggregate move
distribution divergence, and mean per-player Jensen-Shannon style divergence,
alongside the rating-conditioned Maia-2 baseline on the same positions. These
are diagnostics, not proof of style fidelity; PGN Mentor archives are suitable
only for pipeline smoke tests and should not be treated as representative
Lichess behavior.

## Evaluate accuracy by ply bucket

Compare the rating-conditioned baseline and player-embedding ONNX model on the
same held-out positions, grouped by the recorded zero-based ply:

```powershell
python -m scripts.player_model.evaluate_style_buckets
```

By default this uses `artifacts/player_model/final_tuned/dataset/validation.jsonl`
and the models in `public/models/`. The buckets are Opening (ply < 16),
Middlegame (ply 16–40), and Endgame (ply > 40). Accuracy is top-1 among legal
Maia-vocabulary moves, matching the trainer's validation metric. Override paths
with `--validation`, `--base-model`, `--player-model`, `--manifest`, or
`--move-vocab`; use `--batch-size` to tune memory use.

## Browser artifacts

The trainer exports:

- `maia4all_player.onnx`: Maia move logits with inputs `board`, `player_id`,
  and `elo_oppo`; `player_id` replaces the active-player Elo bucket.
- `maia4all_pmn.onnx`: optional classifier that matches 20–50 games of the
  opponent's own moves to the trained prototypes.
- `maia4all_manifest.json`: stable player-ID ordering and matcher metadata.

For a local browser test, copy the exported files into
`public/models/`. The inference worker uses the manifest only when it exists;
without it, the existing rating-conditioned ONNX path is unchanged. For more
than one prototype, the PMN needs at least 20 usable rated Rapid games; if the
history is shorter or unavailable, replay continues with rating-conditioned
Maia. A one-prototype model maps directly to player ID 0 for an exact username
match.

The historical PGN smoke-test corpus is not equivalent to recent rapid Lichess
games. Replace it with appropriately licensed, representative PGNs before
evaluating product-quality matching.
