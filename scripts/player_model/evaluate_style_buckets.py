"""Compare Maia-2 and player-conditioned Maia accuracy across game phases."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import chess
import numpy as np
import onnxruntime as ort
from maia2.utils import board_to_tensor, create_elo_dict, map_to_category

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = (
    ROOT / "artifacts" / "player_model" / "final_tuned" / "dataset" / "validation.jsonl"
)
DEFAULT_BASE_MODEL = ROOT / "public" / "models" / "maia2_rapid_fp16.onnx"
DEFAULT_PLAYER_MODEL = ROOT / "public" / "models" / "maia4all_player.onnx"
DEFAULT_MANIFEST = ROOT / "public" / "models" / "maia4all_manifest.json"
DEFAULT_MOVE_VOCAB = ROOT / "public" / "data" / "move_vocab.json"
BUCKETS = ("Opening", "Middlegame", "Endgame")
OUTPUT_NAME = "logits_maia"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare legal-move top-1 accuracy for baseline and player-specific "
            "Maia models by position ply."
        )
    )
    parser.add_argument("--validation", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--base-model", type=Path, default=DEFAULT_BASE_MODEL)
    parser.add_argument("--player-model", type=Path, default=DEFAULT_PLAYER_MODEL)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--move-vocab", type=Path, default=DEFAULT_MOVE_VOCAB)
    parser.add_argument("--batch-size", type=int, default=256)
    return parser.parse_args()


def bucket_for_ply(ply: int) -> str:
    if ply < 0:
        raise ValueError(f"Ply must be non-negative, got {ply}.")
    if ply < 16:
        return "Opening"
    if ply <= 40:
        return "Middlegame"
    return "Endgame"


def load_manifest(path: Path) -> int:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"Model manifest must be a JSON object: {path}")
    players = manifest.get("players")
    if not isinstance(players, list) or not players:
        raise ValueError(f"Model manifest must contain a non-empty players list: {path}")
    for expected_id, player in enumerate(players):
        if not isinstance(player, dict) or player.get("id") != expected_id:
            raise ValueError(
                f"Model manifest player IDs must be sequential from zero: {path}"
            )
    return len(players)


def load_model(path: Path, inputs: set[str]) -> ort.InferenceSession:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    available_inputs = {item.name for item in session.get_inputs()}
    if not inputs.issubset(available_inputs):
        missing = ", ".join(sorted(inputs - available_inputs))
        raise ValueError(f"Model {path} is missing required inputs: {missing}")
    if OUTPUT_NAME not in {item.name for item in session.get_outputs()}:
        raise ValueError(f"Model {path} has no {OUTPUT_NAME!r} output.")
    return session


def validate_logits(logits: np.ndarray, batch_size: int, path: Path) -> None:
    if logits.ndim != 2 or logits.shape[0] != batch_size or logits.shape[1] != 1880:
        raise ValueError(
            f"Model {path} returned logits with unexpected shape {logits.shape}; "
            f"expected ({batch_size}, 1880)."
        )
    if not np.isfinite(logits).all():
        raise ValueError(f"Model {path} returned non-finite logits.")


def evaluate_batch(
    rows: list[dict[str, Any]],
    base_session: ort.InferenceSession,
    player_session: ort.InferenceSession,
    move_to_index: dict[str, int],
    elo_dict: dict[int, int],
    number_of_players: int,
    counts: dict[str, dict[str, int]],
    line_numbers: list[int],
    dataset_path: Path,
    base_model_path: Path,
    player_model_path: Path,
) -> None:
    boards: list[np.ndarray] = []
    player_ids: list[int] = []
    self_buckets: list[int] = []
    opponent_buckets: list[int] = []
    labels: list[int] = []
    legal_indices_by_row: list[list[int]] = []
    buckets_by_row: list[str] = []

    for row, line_number in zip(rows, line_numbers, strict=True):
        context = f"{dataset_path}:{line_number}"
        try:
            player_id = int(row["player_id"])
            ply = int(row["ply"])
            fen = str(row["fen"])
            move = str(row["move"])
            player_rating = row.get("player_rating")
            opponent_rating = row.get("opponent_rating")
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Invalid validation row at {context}.") from error

        if not 0 <= player_id < number_of_players:
            raise ValueError(
                f"Player ID {player_id} is outside the manifest range at {context}."
            )
        if move not in move_to_index:
            raise ValueError(f"Move {move!r} is missing from the vocabulary at {context}.")

        board = chess.Board(fen)
        legal_indices = [
            move_to_index[legal_move.uci()] for legal_move in board.legal_moves
            if legal_move.uci() in move_to_index
        ]
        if not legal_indices:
            raise ValueError(f"No Maia-vocabulary moves are legal at {context}.")

        missing_legal_moves = [
            legal_move.uci()
            for legal_move in board.legal_moves
            if legal_move.uci() not in move_to_index
        ]
        if missing_legal_moves:
            raise ValueError(
                f"Legal moves are missing from the Maia vocabulary at {context}: "
                f"{', '.join(missing_legal_moves)}"
            )

        label = move_to_index[move]
        if label not in legal_indices:
            raise ValueError(f"Recorded move {move!r} is illegal at {context}.")

        board_tensor = board_to_tensor(board)
        boards.append(np.asarray(board_tensor.detach().cpu().numpy(), dtype=np.float32))
        player_ids.append(player_id)
        self_buckets.append(
            map_to_category(
                int(player_rating) if player_rating is not None else 1500,
                elo_dict,
            )
        )
        opponent_buckets.append(
            map_to_category(
                int(opponent_rating) if opponent_rating is not None else 1500,
                elo_dict,
            )
        )
        labels.append(label)
        legal_indices_by_row.append(legal_indices)
        buckets_by_row.append(bucket_for_ply(ply))

    board_batch = np.stack(boards)
    player_id_batch = np.asarray(player_ids, dtype=np.int64)
    self_bucket_batch = np.asarray(self_buckets, dtype=np.int64)
    opponent_bucket_batch = np.asarray(opponent_buckets, dtype=np.int64)

    base_logits = base_session.run(
        [OUTPUT_NAME],
        {
            "board": board_batch.astype(np.float16),
            "elo_self": self_bucket_batch,
            "elo_oppo": opponent_bucket_batch,
        },
    )[0]
    player_logits = player_session.run(
        [OUTPUT_NAME],
        {
            "board": board_batch,
            "player_id": player_id_batch,
            "elo_oppo": opponent_bucket_batch,
        },
    )[0]
    validate_logits(base_logits, len(rows), base_model_path)
    validate_logits(player_logits, len(rows), player_model_path)

    for index, (bucket, legal_indices, label) in enumerate(
        zip(buckets_by_row, legal_indices_by_row, labels, strict=True)
    ):
        base_prediction = legal_indices[
            int(np.argmax(base_logits[index, legal_indices]))
        ]
        player_prediction = legal_indices[
            int(np.argmax(player_logits[index, legal_indices]))
        ]
        counts["Base Maia"][bucket]["positions"] += 1
        counts["Player embeddings"][bucket]["positions"] += 1
        counts["Base Maia"][bucket]["correct"] += int(base_prediction == label)
        counts["Player embeddings"][bucket]["correct"] += int(player_prediction == label)


def main() -> None:
    args = parse_args()
    if args.batch_size < 1:
        raise ValueError("--batch-size must be at least one.")
    for path in (
        args.validation,
        args.base_model,
        args.player_model,
        args.manifest,
        args.move_vocab,
    ):
        if not path.is_file():
            raise FileNotFoundError(f"Required evaluation file does not exist: {path}")

    number_of_players = load_manifest(args.manifest)
    move_vocab = json.loads(args.move_vocab.read_text(encoding="utf-8"))
    if (
        not isinstance(move_vocab, list)
        or len(move_vocab) != 1880
        or len(set(move_vocab)) != 1880
        or not all(isinstance(move, str) for move in move_vocab)
    ):
        raise ValueError(f"Expected 1880 unique move tokens in {args.move_vocab}.")
    move_to_index = {move: index for index, move in enumerate(move_vocab)}
    elo_dict = create_elo_dict()

    base_session = load_model(
        args.base_model, {"board", "elo_self", "elo_oppo"}
    )
    player_session = load_model(
        args.player_model, {"board", "player_id", "elo_oppo"}
    )
    counts: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: {
            bucket: {"positions": 0, "correct": 0}
            for bucket in BUCKETS
        }
    )

    batch: list[dict[str, Any]] = []
    line_numbers: list[int] = []
    with args.validation.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(
                    f"Expected a JSON object at {args.validation}:{line_number}."
                )
            batch.append(row)
            line_numbers.append(line_number)
            if len(batch) == args.batch_size:
                evaluate_batch(
                    batch,
                    base_session,
                    player_session,
                    move_to_index,
                    elo_dict,
                    number_of_players,
                    counts,
                    line_numbers,
                    args.validation,
                    args.base_model,
                    args.player_model,
                )
                batch.clear()
                line_numbers.clear()

    if batch:
        evaluate_batch(
            batch,
            base_session,
            player_session,
            move_to_index,
            elo_dict,
            number_of_players,
            counts,
            line_numbers,
            args.validation,
            args.base_model,
            args.player_model,
        )

    total_positions = sum(
        counts["Base Maia"][bucket]["positions"] for bucket in BUCKETS
    )
    if total_positions == 0:
        raise ValueError(f"No validation positions were found in {args.validation}.")

    print(f"Validation positions: {total_positions:,}")
    print("Accuracy is top-1 among legal Maia-vocabulary moves.")
    print(f"{'Ply bucket':<14} {'Positions':>10} {'Base Maia':>12} {'Player model':>14}")
    for bucket in BUCKETS:
        positions = counts["Base Maia"][bucket]["positions"]
        if not positions:
            print(f"{bucket:<14} {positions:>10} {'n/a':>12} {'n/a':>14}")
            continue
        base_accuracy = counts["Base Maia"][bucket]["correct"] / positions
        player_accuracy = counts["Player embeddings"][bucket]["correct"] / positions
        print(
            f"{bucket:<14} {positions:>10,} "
            f"{base_accuracy:>11.2%} {player_accuracy:>13.2%}"
        )


if __name__ == "__main__":
    main()
