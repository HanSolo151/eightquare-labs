"""Prepare player-labelled Maia training examples from PGN and ZIP sources."""

from __future__ import annotations

import io
import json
import random
import re
import unicodedata
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, TextIO

import chess
import chess.pgn


@dataclass(frozen=True)
class Source:
    path: Path
    member: str | None
    player_name: str


def normalize_name(value: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_name.casefold())


def player_matches(header_name: str, prototype_name: str) -> bool:
    normalized_header = normalize_name(header_name)
    normalized_prototype = normalize_name(prototype_name)
    if (
        len(prototype_name) > 1
        and prototype_name[-1].isupper()
        and normalized_prototype[:-1]
        and normalized_header.startswith(normalized_prototype[:-1])
        and normalized_header[len(normalized_prototype) - 1 : len(normalized_prototype)]
        == prototype_name[-1].casefold()
    ):
        return True
    return bool(normalized_prototype) and (
        normalized_header == normalized_prototype
        or normalized_header.startswith(normalized_prototype)
        or normalized_header.endswith(normalized_prototype)
    )


def mirror_uci(uci: str) -> str:
    if len(uci) < 4:
        raise ValueError(f"Invalid UCI move: {uci}")
    return f"{uci[0]}{9 - int(uci[1])}{uci[2]}{9 - int(uci[3])}{uci[4:]}"


def discover_sources(data_dir: Path) -> list[Source]:
    if not data_dir.exists():
        raise FileNotFoundError(f"PGN source directory does not exist: {data_dir}")

    sources: list[Source] = []
    for path in sorted(data_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.casefold() == ".pgn":
            sources.append(Source(path, None, path.stem))
        elif path.suffix.casefold() == ".zip":
            try:
                with zipfile.ZipFile(path) as archive:
                    members = sorted(
                        name
                        for name in archive.namelist()
                        if name.casefold().endswith(".pgn")
                    )
            except zipfile.BadZipFile as error:
                raise ValueError(f"Invalid PGN archive: {path}") from error
            sources.extend(
                Source(path, member, Path(member).stem) for member in members
            )

    if not sources:
        raise FileNotFoundError(f"No .pgn files or ZIP archives found in {data_dir}")
    return sources


@contextmanager
def open_source(source: Source) -> Iterator[TextIO]:
    if source.member is None:
        with source.path.open("r", encoding="utf-8-sig", errors="replace") as stream:
            yield stream
    else:
        with zipfile.ZipFile(source.path) as archive:
            with archive.open(source.member) as binary_stream:
                with io.TextIOWrapper(
                    binary_stream, encoding="utf-8-sig", errors="replace"
                ) as stream:
                    yield stream


def iter_games(source: Source) -> Iterator[chess.pgn.Game]:
    with open_source(source) as stream:
        while True:
            game = chess.pgn.read_game(stream)
            if game is None:
                return
            yield game


def _rating(tags: chess.pgn.Headers, key: str) -> int | None:
    raw = tags.get(key)
    if not raw or raw in {"?", "-"}:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _positions_for_game(
    game: chess.pgn.Game,
    prototype_name: str,
    player_id: int,
    game_id: str,
) -> list[dict[str, object]]:
    white = game.headers.get("White", "")
    black = game.headers.get("Black", "")
    white_is_player = player_matches(white, prototype_name)
    black_is_player = player_matches(black, prototype_name)
    if white_is_player == black_is_player or game.errors:
        return []

    player_color = chess.WHITE if white_is_player else chess.BLACK
    player_rating = _rating(
        game.headers, "WhiteElo" if white_is_player else "BlackElo"
    )
    opponent_rating = _rating(
        game.headers, "BlackElo" if white_is_player else "WhiteElo"
    )
    board = game.board()
    rows: list[dict[str, object]] = []

    for ply, move in enumerate(game.mainline_moves()):
        if board.turn == player_color:
            canonical_board = board if player_color == chess.WHITE else board.mirror()
            canonical_uci = move.uci()
            if player_color == chess.BLACK:
                canonical_uci = mirror_uci(canonical_uci)
            rows.append(
                {
                    "game_id": game_id,
                    "player_id": player_id,
                    "ply": ply,
                    "fen": canonical_board.fen(),
                    "move": canonical_uci,
                    "player_rating": player_rating,
                    "opponent_rating": opponent_rating,
                }
            )
        board.push(move)

    return rows


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8", newline="\n") as output:
        for row in rows:
            output.write(json.dumps(row, separators=(",", ":")) + "\n")
    temporary_path.replace(path)


def prepare_dataset(
    data_dir: Path,
    output_dir: Path,
    players: list[str] | None = None,
    player_metadata: dict[str, dict[str, object]] | None = None,
    max_players: int = 5,
    max_games_per_player: int = 100,
    max_positions_per_player: int = 10_000,
    validation_fraction: float = 0.2,
    seed: int = 42,
) -> dict[str, object]:
    if max_players < 1 or max_games_per_player < 1 or max_positions_per_player < 1:
        raise ValueError("Player, game, and position limits must all be positive.")
    if not 0 <= validation_fraction < 1:
        raise ValueError("validation_fraction must be at least 0 and less than 1.")

    sources = discover_sources(data_dir)
    source_names = sorted({source.player_name for source in sources})
    selected_players = players or source_names[:max_players]
    if len(selected_players) > max_players and players is not None:
        raise ValueError(
            f"Received {len(selected_players)} players, exceeding max_players={max_players}."
        )
    if not selected_players:
        raise ValueError("No prototype players were selected.")

    player_games: list[list[list[dict[str, object]]]] = []
    player_counts: list[dict[str, object]] = []

    for player_id, player_name in enumerate(selected_players):
        matching_sources = [
            source for source in sources if player_matches(source.player_name, player_name)
        ]
        if not matching_sources:
            raise FileNotFoundError(
                f"No PGN source filename matches prototype {player_name!r}."
            )

        games: list[list[dict[str, object]]] = []
        seen_games = 0
        for source in matching_sources:
            for game in iter_games(source):
                game_id = f"{player_id}:{source.path.name}:{seen_games}"
                rows = _positions_for_game(game, player_name, player_id, game_id)
                if not rows:
                    continue
                games.append(rows)
                seen_games += 1
                if seen_games >= max_games_per_player:
                    break
            if seen_games >= max_games_per_player:
                break

        if not games:
            raise ValueError(
                f"No usable games found for {player_name!r}; check PGN player tags and aliases."
            )

        random.Random(seed + player_id).shuffle(games)
        if len(games) > 1 and validation_fraction > 0:
            validation_count = min(
                len(games) - 1, max(1, round(len(games) * validation_fraction))
            )
        else:
            validation_count = 0
        validation_games = games[:validation_count]
        training_games = games[validation_count:]

        training_budget = max(
            1, round(max_positions_per_player * (1 - validation_fraction))
        )
        validation_budget = max_positions_per_player - training_budget
        training_rows: list[dict[str, object]] = []
        for game_rows in training_games:
            if len(training_rows) >= training_budget:
                break
            remaining = training_budget - len(training_rows)
            training_rows.extend(game_rows[:remaining])

        validation_rows: list[dict[str, object]] = []
        for game_rows in validation_games:
            if len(validation_rows) >= validation_budget:
                break
            remaining = validation_budget - len(validation_rows)
            validation_rows.extend(game_rows[:remaining])

        if not training_rows:
            raise ValueError(f"No training positions were generated for {player_name!r}.")
        player_games.append([training_rows, validation_rows])
        player_counts.append(
            {
                "id": player_id,
                "name": player_name,
                **(
                    player_metadata.get(player_name.casefold(), {})
                    if player_metadata
                    else {}
                ),
                "games": len(games),
                "training_positions": len(training_rows),
                "validation_positions": len(validation_rows),
            }
        )

    train_rows = [row for train, _ in player_games for row in train]
    validation_rows = [row for _, validation in player_games for row in validation]
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(output_dir / "train.jsonl", train_rows)
    _write_jsonl(output_dir / "validation.jsonl", validation_rows)

    manifest: dict[str, object] = {
        "version": 1,
        "players": player_counts,
        "training_positions": len(train_rows),
        "validation_positions": len(validation_rows),
        "validation_split_unit": "game",
        "seed": seed,
    }
    manifest_path = output_dir / "dataset_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return manifest
