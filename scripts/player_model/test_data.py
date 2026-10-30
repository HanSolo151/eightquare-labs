import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.player_model.data import mirror_uci, player_matches, prepare_dataset
from scripts.player_model.train import (
    build_move_sequences,
    build_profile_move_sequences,
    jensen_shannon_divergence,
    mean_player_style_jsd,
    read_roster,
    parse_args,
    run_training,
    shuffle_profile_game_order,
)


class PlayerDataTests(unittest.TestCase):
    def test_training_defaults_enable_regularization_and_best_checkpointing(self) -> None:
        args = parse_args(["--data-dir", "unused"])

        self.assertEqual(args.epochs, 15)
        self.assertEqual(args.early_stopping_patience, 3)
        self.assertEqual(args.matcher_opening_plies, 12)
        self.assertEqual(args.matcher_dropout, 0.5)
        self.assertEqual(args.matcher_weight_decay, 1e-4)

    def test_name_matching_and_black_move_mirroring(self) -> None:
        self.assertTrue(player_matches("Carlsen, Magnus", "Carlsen"))
        self.assertTrue(player_matches("Wesley So", "So"))
        self.assertTrue(player_matches("Polgar, Judit", "PolgarJ"))
        self.assertTrue(player_matches("Réti, Richard", "Reti"))
        self.assertFalse(player_matches("Caruana, Fabiano", "Carlsen"))
        self.assertEqual(mirror_uci("e7e5"), "e2e4")
        self.assertEqual(mirror_uci("a2a1q"), "a7a8q")

    def test_zip_source_splits_whole_games_and_canonicalizes_black(self) -> None:
        pgn = """[Event "one"]
[White "Other Player"]
[Black "Carlsen, Magnus"]
[WhiteElo "1500"]
[BlackElo "2800"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "two"]
[White "Carlsen, Magnus"]
[Black "Other Player"]
[WhiteElo "2800"]
[BlackElo "1500"]
[Result "1-0"]

1. d4 d5 2. c4 e6 1-0
"""
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            archive_path = root / "Carlsen.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("Carlsen.pgn", pgn)

            output_dir = root / "prepared"
            manifest = prepare_dataset(
                data_dir=root,
                output_dir=output_dir,
                players=["Carlsen"],
                max_players=1,
                max_games_per_player=10,
                max_positions_per_player=100,
                validation_fraction=0.5,
                seed=1,
            )

            train_rows = [
                json.loads(line)
                for line in (output_dir / "train.jsonl").read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            validation_rows = [
                json.loads(line)
                for line in (output_dir / "validation.jsonl").read_text(
                    encoding="utf-8"
                ).splitlines()
            ]

        self.assertEqual(len(manifest["players"]), 1)
        self.assertEqual(manifest["validation_split_unit"], "game")
        self.assertTrue(train_rows)
        self.assertTrue(validation_rows)
        self.assertNotEqual(train_rows[0]["game_id"], validation_rows[0]["game_id"])
        self.assertTrue(all(row["fen"].split()[1] == "w" for row in train_rows + validation_rows))
        black_move = next(row for row in train_rows + validation_rows if row["ply"] == 1)
        self.assertEqual(black_move["move"], "e2e4")
        self.assertEqual(black_move["player_rating"], 2800)
        self.assertEqual(black_move["opponent_rating"], 1500)

    def test_move_sequences_are_right_padded_and_jsd_is_zero_for_equal_rates(self) -> None:
        rows = [
            {"player_id": 0, "game_id": "game-1", "ply": 1, "move": "e2e4"},
            {"player_id": 0, "game_id": "game-1", "ply": 3, "move": "g1f3"},
            {"player_id": 1, "game_id": "game-2", "ply": 1, "move": "d2d4"},
        ]
        sequences, labels = build_move_sequences(
            rows, {"e2e4": 0, "g1f3": 1, "d2d4": 2}, 3, 1
        )

        self.assertEqual(sequences, [[1, 0, 0], [1, 2, 0], [3, 0, 0]])
        self.assertEqual(labels, [0, 0, 1])
        self.assertAlmostEqual(jensen_shannon_divergence([2, 1], [4, 2]), 0.0)
        self.assertAlmostEqual(jensen_shannon_divergence([1, 0], [0, 1]), 1.0)
        self.assertAlmostEqual(
            mean_player_style_jsd(
                {0: [2, 1], 1: [1, 2]},
                {0: [4, 2], 1: [2, 4]},
            ),
            0.0,
        )

    def test_profile_sequences_span_multiple_games(self) -> None:
        rows = [
            {"player_id": 0, "game_id": "game-1", "ply": 1, "move": "e2e4"},
            {"player_id": 0, "game_id": "game-2", "ply": 1, "move": "d2d4"},
            {"player_id": 0, "game_id": "game-3", "ply": 1, "move": "g1f3"},
            {"player_id": 1, "game_id": "game-4", "ply": 1, "move": "c2c4"},
        ]
        profiles, labels = build_profile_move_sequences(
            rows, {"e2e4": 0, "d2d4": 1, "g1f3": 2, "c2c4": 3}, 2, 2
        )

        self.assertEqual(profiles, [[[1, 0], [2, 0]], [[2, 0], [3, 0]]])
        self.assertEqual(labels, [0, 0])

    def test_profile_sequences_mask_opening_plies(self) -> None:
        rows = [
            {"player_id": 0, "game_id": "game-1", "ply": 1, "move": "e2e4"},
            {"player_id": 0, "game_id": "game-1", "ply": 11, "move": "d2d4"},
            {"player_id": 0, "game_id": "game-1", "ply": 12, "move": "g1f3"},
            {"player_id": 0, "game_id": "game-1", "ply": 14, "move": "b1c3"},
        ]
        profiles, labels = build_profile_move_sequences(
            rows, {"e2e4": 0, "d2d4": 1, "g1f3": 2, "b1c3": 3}, 3, 1, 12
        )

        self.assertEqual(profiles, [[[3, 4, 0]]])
        self.assertEqual(labels, [0])

    def test_profile_game_order_augmentation_preserves_each_profile(self) -> None:
        import torch

        profiles = torch.tensor(
            [
                [[1, 0], [2, 0], [3, 0], [4, 0]],
                [[5, 0], [6, 0], [7, 0], [8, 0]],
            ]
        )
        torch.manual_seed(42)

        shuffled = shuffle_profile_game_order(profiles, torch)

        for original, augmented in zip(profiles, shuffled, strict=True):
            self.assertEqual(
                original[:, 0].sort().values.tolist(),
                augmented[:, 0].sort().values.tolist(),
            )
        self.assertFalse(torch.equal(profiles, shuffled))

    def test_roster_preserves_stable_ids_and_profile_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            path = Path(temporary_dir) / "roster.json"
            path.write_text(
                json.dumps(
                    {
                        "players": [
                            {
                                "id": 1,
                                "username": "PrototypeB",
                                "rating": 1500,
                                "rating_bin": "1400-1599",
                            },
                            {
                                "id": 0,
                                "username": "PrototypeA",
                                "rating": 950,
                                "rating_bin": "lt1000",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            names, metadata = read_roster(path)

        self.assertEqual(names, ["PrototypeA", "PrototypeB"])
        self.assertEqual(metadata["prototypeb"]["rating_bin"], "1400-1599")

    def test_prepare_only_uses_roster_ids_and_metadata(self) -> None:
        pgn = """[Event "one"]
[White "PrototypeA"]
[Black "Opponent"]
[Result "1-0"]

1. e4 e5 1-0

[Event "two"]
[White "PrototypeA"]
[Black "Opponent"]
[Result "0-1"]

1. d4 d5 0-1
"""
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            data_dir = root / "pgn"
            data_dir.mkdir()
            (data_dir / "PrototypeA.pgn").write_text(pgn, encoding="utf-8")
            roster_path = root / "prototype_roster.json"
            roster_path.write_text(
                json.dumps(
                    {
                        "players": [
                            {
                                "id": 0,
                                "username": "PrototypeA",
                                "rating": 950,
                                "rating_bin": "lt1000",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            args = parse_args(
                [
                    "--data-dir",
                    str(data_dir),
                    "--output-dir",
                    str(root / "output"),
                    "--roster-manifest",
                    str(roster_path),
                    "--max-games-per-player",
                    "2",
                    "--prepare-only",
                ]
            )

            run_training(args)

            manifest = json.loads(
                (root / "output" / "dataset" / "dataset_manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(manifest["players"][0]["id"], 0)
        self.assertEqual(manifest["players"][0]["rating_bin"], "lt1000")
        self.assertEqual(manifest["players"][0]["rating"], 950)


if __name__ == "__main__":
    unittest.main()
