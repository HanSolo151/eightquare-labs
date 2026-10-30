import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.player_model import collect_lichess


class FakeLichessClient:
    def __init__(self) -> None:
        self.profile_requests = 0
        self.game_requests = 0

    def json(self, path: str, params=None, accept="application/json"):
        if path == "/api/player/top/100/rapid":
            return {"users": []}
        if path == "/api/tournament":
            return {"finished": []}
        if path == "/api/user/TargetUser":
            if params != {"profile": "false", "trophies": "false"}:
                raise AssertionError(f"Unexpected profile query: {params}")
            if accept != "application/json":
                raise AssertionError(f"Unexpected profile Accept header: {accept}")
            self.profile_requests += 1
            return {
                "username": "TargetUser",
                "perfs": {"rapid": {"rating": 1350, "games": 100}},
            }
        raise AssertionError(f"Unexpected JSON endpoint: {path}")

    def get(self, path: str, params=None, accept="application/json") -> bytes:
        if path != "/api/games/user/TargetUser":
            raise AssertionError(f"Unexpected GET endpoint: {path}")
        self.game_requests += 1
        self.assert_rapid_game_query(params, accept)
        return (
            '[Event "one"]\n[White "TargetUser"]\n[Black "Opponent1"]\n'
            '[Result "1-0"]\n\n1. e4 e5 1-0\n\n'
            '[Event "two"]\n[White "TargetUser"]\n[Black "Opponent2"]\n'
            '[Result "0-1"]\n\n1. d4 d5 0-1\n'
        ).encode()

    @staticmethod
    def assert_rapid_game_query(params, accept: str) -> None:
        if params != {
            "max": "2",
            "rated": "true",
            "perfType": "rapid",
            "moves": "true",
            "tags": "true",
            "clocks": "false",
            "evals": "false",
            "opening": "false",
        }:
            raise AssertionError(f"Unexpected game query: {params}")
        if accept != "application/x-chess-pgn":
            raise AssertionError(f"Unexpected PGN Accept header: {accept}")


class LichessCollectorTests(unittest.TestCase):
    def test_archives_only_unselected_collector_pgns(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            output_dir = root / "prototypes"
            cache_dir = output_dir / ".downloads"
            output_dir.mkdir()
            cache_dir.mkdir()
            (output_dir / "SelectedPlayer.pgn").write_text("selected", encoding="utf-8")
            (output_dir / "PartialPlayer.pgn").write_text("partial", encoding="utf-8")
            (cache_dir / "PartialPlayer.pgn").write_text("cached", encoding="utf-8")
            (output_dir / "UserSource.pgn").write_text("source", encoding="utf-8")

            collect_lichess._archive_unselected_pgns(
                output_dir, cache_dir, {"SelectedPlayer"}
            )

            self.assertTrue((output_dir / "SelectedPlayer.pgn").exists())
            self.assertFalse((output_dir / "PartialPlayer.pgn").exists())
            self.assertEqual(
                (cache_dir / "unselected" / "PartialPlayer.pgn").read_text(
                    encoding="utf-8"
                ),
                "partial",
            )
            self.assertTrue((output_dir / "UserSource.pgn").exists())

    def test_rating_bin_boundaries(self) -> None:
        self.assertEqual(collect_lichess.rating_bin(999), "lt1000")
        self.assertEqual(collect_lichess.rating_bin(1000), "1000-1199")
        self.assertEqual(collect_lichess.rating_bin(2199), "2000-2199")
        self.assertEqual(collect_lichess.rating_bin(2200), "2200plus")

    def test_discovery_includes_currently_running_rapid_arenas(self) -> None:
        class DiscoveryClient:
            def json(self, path, params=None, accept="application/json"):
                if path == "/api/player/top/100/rapid":
                    if params is not None or accept != "application/vnd.lichess.v3+json":
                        raise AssertionError("Unexpected Rapid leaderboard request.")
                    return {
                        "users": [
                            {
                                "username": "SeedUser",
                                "perfs": {"rapid": {"rating": 1500}},
                            }
                        ]
                    }
                if path == "/api/tournament":
                    if params is not None or accept != "application/json":
                        raise AssertionError("Unexpected tournament schedule request.")
                    return {
                        "started": [
                            {
                                "id": "runningRapid",
                                "rated": True,
                                "startsAt": 200,
                                "perf": {"key": "rapid"},
                            },
                            {
                                "id": "runningBlitz",
                                "rated": True,
                                "startsAt": 300,
                                "perf": {"key": "blitz"},
                            },
                        ],
                        "finished": [
                            {
                                "id": "finishedRapid",
                                "rated": True,
                                "startsAt": 100,
                                "perf": {"key": "rapid"},
                            }
                        ],
                    }
                raise AssertionError(f"Unexpected JSON endpoint: {path}")

            def get(self, path, params=None, accept="application/json"):
                if path.startswith("/api/games/user/"):
                    if params != {
                        "max": "50",
                        "rated": "true",
                        "perfType": "rapid",
                        "moves": "false",
                    }:
                        raise AssertionError(f"Unexpected history query: {params}")
                    if accept != "application/x-ndjson":
                        raise AssertionError("Unexpected history Accept header.")
                    return (
                        '{"rated":true,"variant":"standard","arenaTour":'
                        '{"id":"historicalRapid"}}\n'
                    ).encode()
                if params != {"nb": "1", "sheet": "false"}:
                    raise AssertionError(f"Unexpected tournament query: {params}")
                if accept != "application/x-ndjson":
                    raise AssertionError(f"Unexpected tournament Accept header: {accept}")
                tournament_id = path.split("/")[-2]
                return (
                    f'{{"username":"Player{tournament_id}","rating":1500}}\n'
                ).encode()

        candidates, tournament_ids = collect_lichess.discover_candidates(
            DiscoveryClient(),
            tournament_limit=2,
            participants_per_tournament=1,
            history_seed_players_per_bin=1,
            history_tournament_limit=1,
            extra_tournament_ids=[],
            username_candidates=[],
            seed=1,
        )

        self.assertEqual(
            tournament_ids,
            ["runningRapid", "finishedRapid", "historicalRapid"],
        )
        self.assertEqual(len(candidates), 4)

    def test_verified_candidate_username_is_collected_into_actual_bin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            usernames_path = root / "candidates.txt"
            usernames_path.write_text("TargetUser\n", encoding="utf-8")
            output_dir = root / "prototypes"
            args = collect_lichess.parse_args(
                [
                    "--output-dir",
                    str(output_dir),
                    "--players-per-bin",
                    "1",
                    "--games-per-player",
                    "2",
                    "--candidate-attempts-per-bin",
                    "1",
                    "--tournament-limit",
                    "0",
                    "--candidate-usernames",
                    str(usernames_path),
                ]
            )
            client = FakeLichessClient()
            one_bin = (("1200-1399", 1200, 1400),)

            with patch.object(collect_lichess, "RATING_BINS", one_bin):
                manifest = collect_lichess.collect_corpus(args, client)

            self.assertEqual(client.profile_requests, 1)
            self.assertEqual(client.game_requests, 1)
            self.assertEqual(len(manifest["players"]), 1)
            self.assertEqual(manifest["players"][0]["rating_bin"], "1200-1399")
            self.assertEqual(manifest["players"][0]["games_downloaded"], 2)
            self.assertTrue((output_dir / "TargetUser.pgn").exists())
            self.assertTrue((output_dir / "prototype_roster.json").exists())

    def test_bad_profile_rating_does_not_download_games(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            usernames_path = root / "candidates.txt"
            usernames_path.write_text("TargetUser\n", encoding="utf-8")
            args = collect_lichess.parse_args(
                [
                    "--output-dir",
                    str(root / "prototypes"),
                    "--players-per-bin",
                    "1",
                    "--games-per-player",
                    "2",
                    "--candidate-attempts-per-bin",
                    "1",
                    "--tournament-limit",
                    "0",
                    "--candidate-usernames",
                    str(usernames_path),
                ]
            )
            client = FakeLichessClient()

            with (
                patch.object(
                    collect_lichess,
                    "RATING_BINS",
                    (("1400-1599", 1400, 1600),),
                ),
                patch.object(
                    collect_lichess,
                    "_profile_rating",
                    return_value=(1350, 100),
                ),
                self.assertRaisesRegex(ValueError, "Could not fill rating bin"),
            ):
                collect_lichess.collect_corpus(args, client)

            self.assertEqual(client.game_requests, 0)


if __name__ == "__main__":
    unittest.main()
