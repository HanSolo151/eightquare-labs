"""Build a stratified, resumable Maia prototype corpus from the public Lichess API."""

from __future__ import annotations

import argparse
import io
import json
import random
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import chess.pgn

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = ROOT / "data" / "player_model" / "prototypes"
API_ROOT = "https://lichess.org"
REQUEST_GAP_SECONDS = 1.05
MAX_429_RETRIES = 4
RATING_BINS: tuple[tuple[str, int | None, int | None], ...] = (
    ("lt1000", None, 1000),
    ("1000-1199", 1000, 1200),
    ("1200-1399", 1200, 1400),
    ("1400-1599", 1400, 1600),
    ("1600-1799", 1600, 1800),
    ("1800-1999", 1800, 2000),
    ("2000-2199", 2000, 2200),
    ("2200plus", 2200, None),
)


class LichessApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Candidate:
    username: str
    reported_rating: int
    source: str


class LichessClient:
    def __init__(
        self,
        user_agent: str,
        request_gap_seconds: float = REQUEST_GAP_SECONDS,
        timeout_seconds: float = 60,
    ) -> None:
        if request_gap_seconds < 1:
            raise ValueError("Lichess requests must be spaced at least one second apart.")
        self.user_agent = user_agent
        self.request_gap_seconds = request_gap_seconds
        self.timeout_seconds = timeout_seconds
        self._next_request_at = 0.0

    def get(self, path: str, params: dict[str, str] | None = None, accept: str = "application/json") -> bytes:
        query = f"?{urlencode(params)}" if params else ""
        url = f"{API_ROOT}{path}{query}"
        last_error: Exception | None = None

        for attempt in range(MAX_429_RETRIES + 1):
            wait_seconds = self._next_request_at - time.monotonic()
            if wait_seconds > 0:
                time.sleep(wait_seconds)
            self._next_request_at = time.monotonic() + self.request_gap_seconds
            request = Request(
                url,
                headers={"Accept": accept, "User-Agent": self.user_agent},
                method="GET",
            )
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    return response.read()
            except HTTPError as error:
                if error.code == 429:
                    retry_after = _retry_after_seconds(error.headers.get("Retry-After"))
                    last_error = LichessApiError(429, f"Rate limited by Lichess; waiting {retry_after:.0f}s.")
                    if attempt == MAX_429_RETRIES:
                        raise last_error from error
                    print(str(last_error), file=sys.stderr, flush=True)
                    time.sleep(retry_after)
                    continue
                if error.code >= 500 and attempt < MAX_429_RETRIES:
                    last_error = error
                    time.sleep(min(60, 2 ** (attempt + 1)))
                    continue
                body = error.read(500).decode("utf-8", errors="replace")
                raise LichessApiError(error.code, f"Lichess returned HTTP {error.code}: {body}") from error
            except URLError as error:
                last_error = error
                if attempt == MAX_429_RETRIES:
                    break
                time.sleep(min(60, 2 ** (attempt + 1)))

        raise RuntimeError(f"Lichess request failed after retries: {last_error}") from last_error

    def json(
        self,
        path: str,
        params: dict[str, str] | None = None,
        accept: str = "application/json",
    ) -> Any:
        try:
            return json.loads(self.get(path, params, accept))
        except json.JSONDecodeError as error:
            raise ValueError(f"Lichess returned invalid JSON for {path}.") from error


def _retry_after_seconds(value: str | None) -> float:
    if value:
        try:
            return max(60.0, float(value))
        except ValueError:
            try:
                retry_time = parsedate_to_datetime(value)
                if retry_time.tzinfo is None:
                    retry_time = retry_time.replace(tzinfo=timezone.utc)
                return max(60.0, (retry_time - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return 60.0


def rating_bin(rating: int) -> str | None:
    for label, minimum, maximum in RATING_BINS:
        if (minimum is None or rating >= minimum) and (
            maximum is None or rating < maximum
        ):
            return label
    return None


def _username(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{2,30}", value):
        return None
    return value


def _profile_rating(profile: Any) -> tuple[int, int] | None:
    if not isinstance(profile, dict):
        return None
    perfs = profile.get("perfs")
    rapid = perfs.get("rapid") if isinstance(perfs, dict) else None
    if not isinstance(rapid, dict):
        return None
    rating = rapid.get("rating")
    games = rapid.get("games")
    if not isinstance(rating, int) or not isinstance(games, int):
        return None
    return rating, games


def _candidate_from(
    username: Any, rating: Any, source: str
) -> Candidate | None:
    normalized_username = _username(username)
    if normalized_username is None or not isinstance(rating, int) or rating <= 0:
        return None
    return Candidate(normalized_username, rating, source)


def load_tournament_ids(path: Path | None, explicit_ids: list[str]) -> list[str]:
    ids = list(explicit_ids)
    if path:
        for line in path.read_text(encoding="utf-8").splitlines():
            value = line.strip()
            if value and not value.startswith("#"):
                ids.append(value)
    return list(dict.fromkeys(value for value in ids if value))


def discover_candidates(
    client: LichessClient,
    *,
    tournament_limit: int,
    participants_per_tournament: int,
    history_seed_players_per_bin: int,
    history_tournament_limit: int,
    extra_tournament_ids: list[str],
    username_candidates: list[str],
    seed: int,
) -> tuple[list[Candidate], list[str]]:
    candidates: dict[str, Candidate] = {}
    leaderboard = client.json(
        "/api/player/top/100/rapid",
        accept="application/vnd.lichess.v3+json",
    )
    leaderboard_users = leaderboard.get("users") if isinstance(leaderboard, dict) else None
    if not isinstance(leaderboard_users, list):
        raise ValueError("Lichess Rapid leaderboard did not contain a users array.")
    for entry in leaderboard_users:
        if not isinstance(entry, dict):
            continue
        perfs = entry.get("perfs")
        rapid = perfs.get("rapid") if isinstance(perfs, dict) else None
        candidate = _candidate_from(entry.get("username"), rapid.get("rating") if isinstance(rapid, dict) else None, "rapid-leaderboard")
        if candidate:
            candidates[candidate.username.casefold()] = candidate

    schedule = client.json("/api/tournament")
    if not isinstance(schedule, dict):
        raise ValueError("Lichess recent tournament response was not an object.")
    rapid_tournaments: list[dict[str, Any]] = []
    for status in ("started", "finished"):
        tournaments = schedule.get(status, [])
        if not isinstance(tournaments, list):
            raise ValueError(
                f"Lichess tournament response did not contain a {status} array."
            )
        for tournament in tournaments:
            if not isinstance(tournament, dict) or tournament.get("rated") is not True:
                continue
            perf = tournament.get("perf")
            if (
                isinstance(perf, dict)
                and perf.get("key") == "rapid"
                and isinstance(tournament.get("id"), str)
            ):
                rapid_tournaments.append(tournament)
    rapid_tournaments.sort(
        key=lambda item: int(item.get("startsAt", item.get("finishesAt", 0))),
        reverse=True,
    )

    tournament_ids = [str(item["id"]) for item in rapid_tournaments[:tournament_limit]]
    tournament_ids.extend(extra_tournament_ids)
    tournament_ids = list(dict.fromkeys(tournament_ids))

    def add_tournament_candidates(tournament_id: str) -> None:
        try:
            raw_results = client.get(
                f"/api/tournament/{quote(tournament_id, safe='')}/results",
                params={"nb": str(participants_per_tournament), "sheet": "false"},
                accept="application/x-ndjson",
            )
        except LichessApiError as error:
            if error.status == 404:
                print(
                    f"Skipping unavailable tournament results: {tournament_id}",
                    file=sys.stderr,
                    flush=True,
                )
                return
            raise
        for line in raw_results.splitlines():
            if not line.strip():
                continue
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"Invalid tournament result JSON from {tournament_id}."
                ) from error
            if not isinstance(result, dict):
                continue
            candidate = _candidate_from(
                result.get("username"),
                result.get("rating"),
                f"arena:{tournament_id}",
            )
            if candidate:
                previous = candidates.get(candidate.username.casefold())
                if previous is None or candidate.reported_rating > previous.reported_rating:
                    candidates[candidate.username.casefold()] = candidate

    for tournament_id in tournament_ids:
        add_tournament_candidates(tournament_id)

    rng = random.Random(seed)
    history_tournament_ids: list[str] = []
    if history_tournament_limit > 0 and history_seed_players_per_bin > 0:
        for bin_label, _, _ in RATING_BINS:
            seeds = [
                candidate
                for candidate in candidates.values()
                if rating_bin(candidate.reported_rating) == bin_label
            ]
            rng.shuffle(seeds)
            for candidate in seeds[:history_seed_players_per_bin]:
                try:
                    raw_games = client.get(
                        f"/api/games/user/{quote(candidate.username, safe='')}",
                        params={
                            "max": "50",
                            "rated": "true",
                            "perfType": "rapid",
                            "moves": "false",
                        },
                        accept="application/x-ndjson",
                    )
                except LichessApiError as error:
                    if error.status == 404:
                        continue
                    raise
                for line in raw_games.splitlines():
                    if not line.strip():
                        continue
                    try:
                        game = json.loads(line)
                    except json.JSONDecodeError as error:
                        raise ValueError(
                            f"Invalid Rapid game JSON in {candidate.username}'s history."
                        ) from error
                    arena = game.get("arenaTour") if isinstance(game, dict) else None
                    arena_id = arena.get("id") if isinstance(arena, dict) else None
                    if (
                        isinstance(game, dict)
                        and game.get("rated") is True
                        and game.get("variant") == "standard"
                        and isinstance(arena_id, str)
                        and arena_id not in tournament_ids
                        and arena_id not in history_tournament_ids
                    ):
                        history_tournament_ids.append(arena_id)
                        if len(history_tournament_ids) >= history_tournament_limit:
                            break
                if len(history_tournament_ids) >= history_tournament_limit:
                    break
            if len(history_tournament_ids) >= history_tournament_limit:
                break

    tournament_ids.extend(history_tournament_ids)
    for tournament_id in history_tournament_ids:
        add_tournament_candidates(tournament_id)
    if history_tournament_ids:
        print(
            f"Expanded discovery with {len(history_tournament_ids)} historical Rapid arenas.",
            file=sys.stderr,
            flush=True,
        )

    for username in username_candidates:
        candidate_name = _username(username.strip())
        if candidate_name:
            candidates.setdefault(
                candidate_name.casefold(),
                Candidate(candidate_name, 0, "provided-candidate"),
            )

    result = list(candidates.values())
    rng.shuffle(result)
    return result, tournament_ids


def _read_pgn_games(pgn_text: str) -> list[chess.pgn.Game]:
    games: list[chess.pgn.Game] = []
    stream = io.StringIO(pgn_text)
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            return games
        if not game.errors and list(game.mainline_moves()):
            games.append(game)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(content, encoding="utf-8", newline="\n")
    temporary_path.replace(path)


def collect_corpus(args: argparse.Namespace, client: LichessClient | None = None) -> dict[str, Any]:
    client = client or LichessClient(args.user_agent, args.request_gap_seconds)
    candidate_usernames = (
        [
            line.strip()
            for line in args.candidate_usernames.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        if args.candidate_usernames
        else []
    )
    tournament_ids = load_tournament_ids(
        args.tournament_ids_file, args.tournament_id
    )
    candidates, tournament_ids = discover_candidates(
        client,
        tournament_limit=args.tournament_limit,
        participants_per_tournament=args.participants_per_tournament,
        history_seed_players_per_bin=args.history_seed_players_per_bin,
        history_tournament_limit=args.history_tournament_limit,
        extra_tournament_ids=tournament_ids,
        username_candidates=candidate_usernames,
        seed=args.seed,
    )

    candidates_by_bin: dict[str, list[Candidate]] = {
        label: [] for label, _, _ in RATING_BINS
    }
    unrated_candidates: list[Candidate] = []
    for candidate in candidates:
        candidate_bin = rating_bin(candidate.reported_rating)
        if candidate_bin:
            candidates_by_bin[candidate_bin].append(candidate)
        else:
            unrated_candidates.append(candidate)

    if args.discover_only:
        return {
            "candidate_counts": {
                label: len(bucket) for label, bucket in candidates_by_bin.items()
            },
            "unrated_candidate_count": len(unrated_candidates),
            "tournament_ids": tournament_ids,
            "unique_candidates": len(candidates),
        }

    print(
        "Candidate pool by rating bin: "
        + ", ".join(
            f"{label}={len(bucket)}" for label, bucket in candidates_by_bin.items()
        ),
        file=sys.stderr,
        flush=True,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = args.output_dir / ".downloads"
    cache_dir.mkdir(parents=True, exist_ok=True)
    selected: list[dict[str, Any]] = []
    profile_cache: dict[str, tuple[int, int] | None] = {}
    username_cache: dict[str, str] = {}
    rng = random.Random(args.seed)

    for bin_label, _, _ in RATING_BINS:
        pool = candidates_by_bin[bin_label][:]
        pool.extend(unrated_candidates)
        rng.shuffle(pool)
        examined = 0
        examined_in_bin: set[str] = set()
        for candidate in pool:
            if sum(player["rating_bin"] == bin_label for player in selected) >= args.players_per_bin:
                break
            if examined >= args.candidate_attempts_per_bin:
                break
            key = candidate.username.casefold()
            if key in examined_in_bin:
                continue
            examined_in_bin.add(key)
            examined += 1
            profile_info = profile_cache.get(key)
            if key not in profile_cache:
                try:
                    profile = client.json(
                        f"/api/user/{quote(candidate.username, safe='')}",
                        params={"profile": "false", "trophies": "false"},
                    )
                except LichessApiError as error:
                    if error.status == 404:
                        profile_cache[key] = None
                        continue
                    raise
                profile_info = _profile_rating(profile)
                profile_cache[key] = profile_info
                canonical_name = _username(profile.get("username")) if isinstance(profile, dict) else None
                username_cache[key] = canonical_name or candidate.username
            else:
                profile_info = profile_cache[key]
            if profile_info is None:
                continue

            current_rating, rapid_games = profile_info
            actual_bin = rating_bin(current_rating)
            if rapid_games < args.games_per_player or actual_bin is None:
                continue
            if sum(player["rating_bin"] == actual_bin for player in selected) >= args.players_per_bin:
                continue
            if any(player["username"].casefold() == key for player in selected):
                continue

            username = username_cache[key]
            pgn_path = args.output_dir / f"{_safe_filename(username)}.pgn"
            if pgn_path.exists():
                existing_games = len(
                    _read_pgn_games(pgn_path.read_text(encoding="utf-8"))
                )
                if existing_games == args.games_per_player:
                    game_count = existing_games
                else:
                    game_count = _download_player_games(
                        client, username, args.games_per_player, cache_dir
                    )
            else:
                game_count = _download_player_games(
                    client, username, args.games_per_player, cache_dir
                )
            if game_count != args.games_per_player:
                print(
                    f"Skipping {username}: only {game_count}/{args.games_per_player} "
                    f"valid rated Rapid games were available.",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            if not pgn_path.exists():
                cached_pgn = cache_dir / f"{_safe_filename(username)}.pgn"
                pgn_path.write_bytes(cached_pgn.read_bytes())
            selected.append(
                {
                    "id": len(selected),
                    "username": username,
                    "rating": current_rating,
                    "rating_bin": actual_bin,
                    "rapid_games_available": rapid_games,
                    "games_downloaded": game_count,
                    "candidate_source": candidate.source,
                }
            )
            print(
                f"Selected {sum(player['rating_bin'] == actual_bin for player in selected)}/"
                f"{args.players_per_bin} for {actual_bin}: {username} ({current_rating})",
                flush=True,
            )
        selected_in_bin = sum(player["rating_bin"] == bin_label for player in selected)
        if selected_in_bin < args.players_per_bin:
            raise ValueError(
                f"Could not fill rating bin {bin_label}: selected "
                f"{selected_in_bin}/"
                f"{args.players_per_bin} after checking {examined} candidates. "
                "Increase --tournament-limit, --participants-per-tournament, "
                "or --candidate-attempts-per-bin and retry."
            )

    selected.sort(
        key=lambda player: (
            next(index for index, (label, _, _) in enumerate(RATING_BINS) if label == player["rating_bin"]),
            player["username"].casefold(),
        )
    )
    for player_id, player in enumerate(selected):
        player["id"] = player_id
    manifest = {
        "version": 1,
        "source": "Lichess public API",
        "perf_type": "rapid",
        "rated_only": True,
        "games_per_player": args.games_per_player,
        "players_per_bin": args.players_per_bin,
        "rating_bins": [
            {"label": label, "min_rating": minimum, "max_rating_exclusive": maximum}
            for label, minimum, maximum in RATING_BINS
        ],
        "tournament_ids": tournament_ids,
        "seed": args.seed,
        "players": selected,
    }
    _archive_unselected_pgns(
        args.output_dir,
        cache_dir,
        {str(player["username"]) for player in selected},
    )
    _atomic_write(
        args.output_dir / "prototype_roster.json",
        json.dumps(manifest, indent=2) + "\n",
    )
    return manifest


def _safe_filename(username: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", username)


def _archive_unselected_pgns(
    output_dir: Path, cache_dir: Path, selected_usernames: set[str]
) -> None:
    selected_files = {
        f"{_safe_filename(username)}.pgn".casefold()
        for username in selected_usernames
    }
    archive_dir = cache_dir / "unselected"
    for path in output_dir.glob("*.pgn"):
        if path.name.casefold() in selected_files:
            continue
        cached_path = cache_dir / path.name
        if not cached_path.exists():
            continue
        archive_dir.mkdir(parents=True, exist_ok=True)
        destination = archive_dir / path.name
        if destination.exists():
            raise FileExistsError(
                f"Cannot archive unselected PGN because the destination exists: {destination}"
            )
        path.replace(destination)


def _download_player_games(
    client: LichessClient, username: str, max_games: int, cache_dir: Path
) -> int:
    pgn_text = client.get(
        f"/api/games/user/{quote(username, safe='')}",
        params={
            "max": str(max_games),
            "rated": "true",
            "perfType": "rapid",
            "moves": "true",
            "tags": "true",
            "clocks": "false",
            "evals": "false",
            "opening": "false",
        },
        accept="application/x-chess-pgn",
    ).decode("utf-8-sig", errors="replace")
    games = _read_pgn_games(pgn_text)
    if len(games) > max_games:
        games = games[:max_games]
    cached_path = cache_dir / f"{_safe_filename(username)}.pgn"
    _atomic_write(cached_path, "\n\n".join(game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=False)) for game in games) + ("\n" if games else ""))
    return len(games)


def _read_tournament_ids(path: str | None) -> Path | None:
    return Path(path) if path else None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--players-per-bin", type=int, default=15)
    parser.add_argument("--games-per-player", type=int, default=100)
    parser.add_argument("--tournament-limit", type=int, default=25)
    parser.add_argument("--participants-per-tournament", type=int, default=5000)
    parser.add_argument("--history-seed-players-per-bin", type=int, default=3)
    parser.add_argument("--history-tournament-limit", type=int, default=50)
    parser.add_argument("--tournament-id", action="append", default=[])
    parser.add_argument("--tournament-ids-file", type=_read_tournament_ids)
    parser.add_argument("--candidate-usernames", type=Path)
    parser.add_argument("--candidate-attempts-per-bin", type=int, default=250)
    parser.add_argument("--request-gap-seconds", type=float, default=REQUEST_GAP_SECONDS)
    parser.add_argument(
        "--user-agent",
        default="EightSquareLabs-MaiaPrototypeCorpus/1.0",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--discover-only", action="store_true")
    args = parser.parse_args(argv)
    if args.players_per_bin < 1 or args.games_per_player < 1:
        parser.error("Players per bin and games per player must be positive.")
    if args.tournament_limit < 0 or args.participants_per_tournament < 1:
        parser.error("Tournament limits must be non-negative and participant limits positive.")
    if args.history_seed_players_per_bin < 0 or args.history_tournament_limit < 0:
        parser.error("History discovery limits must be non-negative.")
    if args.candidate_attempts_per_bin < 1:
        parser.error("Candidate attempts per bin must be positive.")
    if args.request_gap_seconds < 1:
        parser.error("Lichess requests must be spaced at least one second apart.")
    return args


if __name__ == "__main__":
    try:
        result = collect_corpus(parse_args())
    except (LichessApiError, OSError, RuntimeError, ValueError) as error:
        print(f"Corpus collection failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(result, indent=2))
