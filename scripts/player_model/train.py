"""Fine-tune Maia-2 player embeddings and export Maia and PMN ONNX models."""

from __future__ import annotations

import argparse
import copy
import json
import math
import random
from collections import defaultdict
from pathlib import Path
from typing import Any

from scripts.player_model.data import prepare_dataset

ROOT = Path(__file__).resolve().parents[2]
MOVE_VOCAB_PATH = ROOT / "public" / "data" / "move_vocab.json"
DEFAULT_OUTPUT_DIR = ROOT / "artifacts" / "player_model"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def read_roster(path: Path) -> tuple[list[str], dict[str, dict[str, object]]]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    roster = manifest.get("players") if isinstance(manifest, dict) else None
    if not isinstance(roster, list) or not roster:
        raise ValueError(f"Prototype roster {path} must contain a non-empty players list.")

    ordered = sorted(
        roster,
        key=lambda player: player.get("id", -1)
        if isinstance(player, dict) and isinstance(player.get("id"), int)
        else -1,
    )
    names: list[str] = []
    metadata: dict[str, dict[str, object]] = {}
    for expected_id, player in enumerate(ordered):
        if not isinstance(player, dict):
            raise ValueError(f"Prototype roster entry {expected_id} is not an object.")
        name = player.get("username")
        player_id = player.get("id")
        rating = player.get("rating")
        rating_bin = player.get("rating_bin")
        if (
            not isinstance(name, str)
            or not name.strip()
            or player_id != expected_id
            or not isinstance(rating, int)
            or not isinstance(rating_bin, str)
        ):
            raise ValueError(
                f"Prototype roster entry {expected_id} must have sequential id, "
                "username, integer rating, and rating_bin."
            )
        key = name.casefold()
        if key in metadata:
            raise ValueError(f"Prototype roster contains duplicate username {name!r}.")
        names.append(name)
        metadata[key] = {
            "username": name,
            "rating": rating,
            "rating_bin": rating_bin,
        }
    return names, metadata


def jensen_shannon_divergence(observed: list[float], predicted: list[float]) -> float:
    observed_total = sum(observed)
    predicted_total = sum(predicted)
    if observed_total <= 0 or predicted_total <= 0:
        raise ValueError("Jensen-Shannon divergence requires non-empty distributions.")

    p = [value / observed_total for value in observed]
    q = [value / predicted_total for value in predicted]
    middle = [(left + right) / 2 for left, right in zip(p, q, strict=True)]

    def kl_divergence(distribution: list[float]) -> float:
        return sum(
            value * math.log2(value / middle_value)
            for value, middle_value in zip(distribution, middle, strict=True)
            if value > 0 and middle_value > 0
        )

    return (kl_divergence(p) + kl_divergence(q)) / 2


def mean_player_style_jsd(
    observed_by_player: dict[int, list[float]],
    predicted_by_player: dict[int, list[float]],
) -> float:
    if not observed_by_player or set(observed_by_player) != set(predicted_by_player):
        raise ValueError("Style divergence requires matching player distributions.")
    return sum(
        jensen_shannon_divergence(
            observed_by_player[player_id], predicted_by_player[player_id]
        )
        for player_id in observed_by_player
    ) / len(observed_by_player)


def build_move_sequences(
    rows: list[dict[str, Any]],
    move_to_index: dict[str, int],
    window_size: int,
    minimum_moves: int,
) -> tuple[list[list[int]], list[int]]:
    games: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        games[(int(row["player_id"]), str(row["game_id"]))].append(row)

    sequences: list[list[int]] = []
    labels: list[int] = []
    for (player_id, _), game_rows in games.items():
        game_rows.sort(key=lambda row: int(row["ply"]))
        tokens = [move_to_index[str(row["move"])] + 1 for row in game_rows]
        for end in range(minimum_moves, len(tokens) + 1):
            recent = tokens[max(0, end - window_size) : end]
            sequences.append(recent + [0] * (window_size - len(recent)))
            labels.append(player_id)
    return sequences, labels


def build_profile_move_sequences(
    rows: list[dict[str, Any]],
    move_to_index: dict[str, int],
    moves_per_game: int,
    history_games: int,
    opening_plies: int = 0,
) -> tuple[list[list[list[int]]], list[int]]:
    games_by_player: dict[int, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in rows:
        games_by_player[int(row["player_id"])][str(row["game_id"])].append(row)

    profiles: list[list[list[int]]] = []
    labels: list[int] = []
    for player_id, games in games_by_player.items():
        game_sequences: list[list[int]] = []
        for game_rows in games.values():
            game_rows.sort(key=lambda row: int(row["ply"]))
            tokens = [
                move_to_index[str(row["move"])] + 1
                for row in game_rows
                if int(row["ply"]) >= opening_plies
            ]
            if tokens:
                recent = tokens[-moves_per_game:]
                game_sequences.append(
                    recent + [0] * (moves_per_game - len(recent))
                )
        for start in range(len(game_sequences) - history_games + 1):
            profiles.append(game_sequences[start : start + history_games])
            labels.append(player_id)
    return profiles, labels


def shuffle_profile_game_order(profile_move_ids: Any, torch_module: Any) -> Any:
    if profile_move_ids.ndim != 3:
        raise ValueError("Profile move IDs must have batch, games, and moves dimensions.")
    game_order = torch_module.rand(
        profile_move_ids.shape[:2], device=profile_move_ids.device
    ).argsort(dim=1)
    return profile_move_ids.gather(
        1, game_order.unsqueeze(-1).expand_as(profile_move_ids)
    )


def run_training(args: argparse.Namespace) -> None:
    dataset_dir = args.output_dir / "dataset"
    if args.roster_manifest and args.players:
        raise ValueError("--roster-manifest and --players cannot be used together.")
    roster_players: list[str] | None = None
    roster_metadata: dict[str, dict[str, object]] | None = None
    if args.roster_manifest:
        roster_players, roster_metadata = read_roster(args.roster_manifest)
    dataset_manifest = prepare_dataset(
        data_dir=args.data_dir,
        output_dir=dataset_dir,
        players=roster_players or args.players,
        player_metadata=roster_metadata,
        max_players=len(roster_players) if roster_players else args.max_players,
        max_games_per_player=args.max_games_per_player,
        max_positions_per_player=args.max_positions_per_player,
        validation_fraction=args.validation_fraction,
        seed=args.seed,
    )
    if args.prepare_only:
        print(json.dumps(dataset_manifest, indent=2))
        return

    try:
        import numpy as np
        import torch
        import torch.nn as nn
        from torch.utils.data import DataLoader, Dataset, TensorDataset
        import chess
        from maia2 import model as maia2_model
        from maia2.utils import board_to_tensor, create_elo_dict, map_to_category
    except ImportError as error:
        raise RuntimeError(
            "Training dependencies are missing. Install scripts/player_model/requirements.txt "
            "in the selected Python environment."
        ) from error

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    move_vocab = json.loads(args.move_vocab.read_text(encoding="utf-8"))
    if len(move_vocab) != 1880 or len(set(move_vocab)) != 1880:
        raise ValueError(f"Expected 1880 unique Maia move tokens in {args.move_vocab}.")
    move_to_index = {move: index for index, move in enumerate(move_vocab)}
    train_rows = read_jsonl(dataset_dir / "train.jsonl")
    validation_rows = read_jsonl(dataset_dir / "validation.jsonl")

    class PositionDataset(Dataset):
        def __init__(self, rows: list[dict[str, Any]]) -> None:
            self.rows = rows
            self.elo_dict = create_elo_dict()

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(
            self, index: int
        ) -> tuple[Any, int, int, int, int, int]:
            row = self.rows[index]
            move = str(row["move"])
            if move not in move_to_index:
                raise ValueError(
                    f"Move {move!r} is missing from Maia's move vocabulary."
                )
            player_rating = row.get("player_rating")
            opponent_rating = row.get("opponent_rating")
            return (
                torch.as_tensor(
                    board_to_tensor(chess.Board(str(row["fen"]))),
                    dtype=torch.float32,
                ),
                int(row["player_id"]),
                map_to_category(
                    int(player_rating) if player_rating is not None else 1500,
                    self.elo_dict,
                ),
                map_to_category(
                    int(opponent_rating)
                    if opponent_rating is not None
                    else 1500,
                    self.elo_dict,
                ),
                move_to_index[move],
                index,
            )

    def create_position_dataset(rows: list[dict[str, Any]]) -> PositionDataset:
        if not rows:
            raise ValueError("A position dataset cannot be empty.")
        return PositionDataset(rows)

    train_dataset = create_position_dataset(train_rows)
    validation_dataset = (
        create_position_dataset(validation_rows) if validation_rows else None
    )
    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    model_cache = args.maia_model_dir or Path("./maia2_models")
    base_model = maia2_model.from_pretrained(
        "rapid", device, save_root=str(model_cache)
    )
    baseline_residual_block = copy.deepcopy(base_model.chess_cnn.layers[-1])
    base_embedding = base_model.elo_embedding
    number_of_elo_buckets = int(base_embedding.num_embeddings)
    if number_of_elo_buckets != 11:
        raise ValueError(
            f"Unexpected Maia-2 Elo embedding count: {number_of_elo_buckets}; expected 11."
        )

    class CombinedPlayerEmbedding(nn.Module):
        def __init__(self, elo_embedding: nn.Embedding, number_of_players: int) -> None:
            super().__init__()
            self.elo_embedding = elo_embedding
            self.number_of_elo_buckets = elo_embedding.num_embeddings
            self.num_embeddings = (
                elo_embedding.num_embeddings + number_of_players
            )
            self.embedding_dim = elo_embedding.embedding_dim
            self.player_embeddings = nn.Embedding(
                number_of_players,
                elo_embedding.embedding_dim,
                device=elo_embedding.weight.device,
                dtype=elo_embedding.weight.dtype,
            )
            with torch.no_grad():
                initial = elo_embedding.weight[-1].detach().clone()
                self.player_embeddings.weight.copy_(
                    initial.unsqueeze(0).expand(number_of_players, -1)
                )
            self.elo_embedding.requires_grad_(False)

        def forward(self, indices: torch.Tensor) -> torch.Tensor:
            is_player = indices >= self.number_of_elo_buckets
            elo_indices = indices.clamp(0, self.number_of_elo_buckets - 1)
            player_indices = (indices - self.number_of_elo_buckets).clamp(
                0, self.player_embeddings.num_embeddings - 1
            )
            return torch.where(
                is_player.unsqueeze(-1),
                self.player_embeddings(player_indices),
                self.elo_embedding(elo_indices),
            )

    number_of_players = len(dataset_manifest["players"])
    player_embedding = CombinedPlayerEmbedding(base_embedding, number_of_players)
    base_model.elo_embedding = player_embedding
    base_model.requires_grad_(False)
    player_embedding.player_embeddings.weight.requires_grad_(True)
    final_residual_block = base_model.chess_cnn.layers[-1]
    final_residual_block.requires_grad_(True)
    baseline_residual_block.to(device).eval()
    base_model.eval()

    train_loader = DataLoader(
        train_dataset, batch_size=args.batch_size, shuffle=True, num_workers=0
    )
    validation_loader = (
        DataLoader(
            validation_dataset,
            batch_size=args.batch_size,
            shuffle=False,
            num_workers=0,
        )
        if validation_dataset is not None
        else None
    )
    trainable_parameters = [
        parameter for parameter in base_model.parameters() if parameter.requires_grad
    ]
    optimizer = torch.optim.Adam(trainable_parameters, lr=args.learning_rate)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=args.epochs
    )
    criterion = nn.CrossEntropyLoss()
    history: list[dict[str, float | int | None]] = []
    baseline_metrics: dict[str, float] | None = None
    best_model_state: dict[str, Any] | None = None
    best_validation_top1 = -1.0
    best_epoch = 0
    epochs_without_improvement = 0
    stopped_early = False
    base_model.to(device)

    for epoch in range(args.epochs):
        base_model.eval()
        total_loss = 0.0
        correct = 0
        seen = 0
        for boards, player_ids, _, opponent_ids, labels, _ in train_loader:
            boards = boards.to(device)
            active_ids = player_ids.to(device) + number_of_elo_buckets
            opponent_ids = opponent_ids.to(device)
            labels = labels.to(device)
            logits = base_model(boards, active_ids, opponent_ids)[0]
            loss = criterion(logits, labels)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * labels.size(0)
            correct += (logits.argmax(dim=-1) == labels).sum().item()
            seen += labels.size(0)

        epoch_metrics: dict[str, float | int | None] = {
            "epoch": epoch + 1,
            "training_loss": total_loss / seen,
            "training_top1": correct / seen,
            "validation_loss": None,
            "validation_top1": None,
            "validation_move_jsd": None,
            "validation_player_style_jsd": None,
            "baseline_validation_top1": None,
            "baseline_validation_move_jsd": None,
            "baseline_validation_player_style_jsd": None,
        }
        if validation_loader is not None:
            base_model.eval()
            validation_loss = 0.0
            validation_correct = 0
            baseline_validation_correct = 0
            validation_seen = 0
            observed_counts = np.zeros(len(move_vocab), dtype=np.float64)
            predicted_counts = np.zeros(len(move_vocab), dtype=np.float64)
            baseline_predicted_counts = np.zeros(
                len(move_vocab), dtype=np.float64
            )
            observed_by_player: dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros(len(move_vocab), dtype=np.float64)
            )
            predicted_by_player: dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros(len(move_vocab), dtype=np.float64)
            )
            baseline_predicted_by_player: dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros(len(move_vocab), dtype=np.float64)
            )
            with torch.no_grad():
                for (
                    boards,
                    player_ids,
                    player_rating_buckets,
                    opponent_ids,
                    labels,
                    row_indices,
                ) in validation_loader:
                    boards = boards.to(device)
                    active_ids = player_ids.to(device) + number_of_elo_buckets
                    player_rating_buckets = player_rating_buckets.to(device)
                    opponent_ids = opponent_ids.to(device)
                    labels = labels.to(device)
                    logits = base_model(boards, active_ids, opponent_ids)[0]
                    baseline_logits = None
                    if epoch == 0:
                        base_model.chess_cnn.layers[-1] = baseline_residual_block
                        baseline_logits = base_model(
                            boards, player_rating_buckets, opponent_ids
                        )[0]
                        base_model.chess_cnn.layers[-1] = final_residual_block
                    validation_loss += criterion(logits, labels).item() * labels.size(0)
                    validation_seen += labels.size(0)
                    label_counts = torch.bincount(labels, minlength=len(move_vocab))
                    observed_counts += label_counts.cpu().numpy()
                    for batch_index, row_index in enumerate(row_indices.tolist()):
                        player_id = int(validation_rows[row_index]["player_id"])
                        observed_by_player[player_id][
                            int(labels[batch_index].item())
                        ] += 1
                        board = chess.Board(str(validation_rows[row_index]["fen"]))
                        legal_indices = []
                        for legal_move in board.legal_moves:
                            legal_uci = legal_move.uci()
                            if legal_uci not in move_to_index:
                                raise ValueError(
                                    f"Legal move {legal_uci!r} is missing from Maia's vocabulary."
                                )
                            legal_indices.append(move_to_index[legal_uci])
                        if not legal_indices:
                            raise ValueError(
                                f"No Maia vocabulary moves are legal in {board.fen()}."
                            )
                        legal_logits = logits[batch_index, legal_indices]
                        prediction = legal_indices[int(legal_logits.argmax().item())]
                        validation_correct += int(
                            prediction == int(labels[batch_index].item())
                        )
                        legal_probabilities = torch.softmax(
                            legal_logits, dim=0
                        ).cpu().numpy()
                        predicted_counts[legal_indices] += legal_probabilities
                        predicted_by_player[player_id][legal_indices] += (
                            legal_probabilities
                        )
                        if baseline_logits is not None:
                            baseline_legal_logits = baseline_logits[
                                batch_index, legal_indices
                            ]
                            baseline_prediction = legal_indices[
                                int(baseline_legal_logits.argmax().item())
                            ]
                            baseline_validation_correct += int(
                                baseline_prediction == int(labels[batch_index].item())
                            )
                            baseline_probabilities = torch.softmax(
                                baseline_legal_logits, dim=0
                            ).cpu().numpy()
                            baseline_predicted_counts[legal_indices] += (
                                baseline_probabilities
                            )
                            baseline_predicted_by_player[player_id][
                                legal_indices
                            ] += baseline_probabilities
            epoch_metrics["validation_loss"] = validation_loss / validation_seen
            validation_top1 = validation_correct / validation_seen
            epoch_metrics["validation_top1"] = validation_top1
            epoch_metrics["validation_move_jsd"] = jensen_shannon_divergence(
                observed_counts.tolist(), predicted_counts.tolist()
            )
            epoch_metrics["validation_player_style_jsd"] = mean_player_style_jsd(
                {
                    player_id: counts.tolist()
                    for player_id, counts in observed_by_player.items()
                },
                {
                    player_id: counts.tolist()
                    for player_id, counts in predicted_by_player.items()
                },
            )
            if epoch == 0:
                baseline_metrics = {
                    "baseline_validation_top1": (
                        baseline_validation_correct / validation_seen
                    ),
                    "baseline_validation_move_jsd": jensen_shannon_divergence(
                        observed_counts.tolist(), baseline_predicted_counts.tolist()
                    ),
                    "baseline_validation_player_style_jsd": mean_player_style_jsd(
                        {
                            player_id: counts.tolist()
                            for player_id, counts in observed_by_player.items()
                        },
                        {
                            player_id: counts.tolist()
                            for player_id, counts in baseline_predicted_by_player.items()
                        },
                    ),
                }
            if baseline_metrics is None:
                raise RuntimeError("Baseline validation metrics were not computed.")
            epoch_metrics.update(baseline_metrics)

            if validation_top1 > best_validation_top1:
                best_validation_top1 = validation_top1
                best_epoch = epoch + 1
                best_model_state = {
                    name: tensor.detach().cpu().clone()
                    for name, tensor in base_model.state_dict().items()
                }
                epochs_without_improvement = 0
            else:
                epochs_without_improvement += 1

        scheduler.step()
        epoch_metrics["learning_rate"] = scheduler.get_last_lr()[0]
        history.append(epoch_metrics)
        print(json.dumps(epoch_metrics, sort_keys=True))
        if (
            validation_loader is not None
            and epochs_without_improvement >= args.early_stopping_patience
        ):
            stopped_early = True
            print(
                json.dumps(
                    {
                        "early_stopping": True,
                        "best_epoch": best_epoch,
                        "best_validation_top1": best_validation_top1,
                    },
                    sort_keys=True,
                )
            )
            break

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if best_model_state is not None:
        base_model.load_state_dict(best_model_state)
    player_model_path = args.output_dir / "maia4all_player.onnx"
    torch.save(
        player_embedding.player_embeddings.state_dict(),
        args.output_dir / "player_embeddings.pt",
    )
    torch.save(base_model.state_dict(), args.output_dir / "maia4all_checkpoint.pt")

    class PlayerIdInferenceModel(nn.Module):
        def __init__(self, model: nn.Module, elo_buckets: int) -> None:
            super().__init__()
            self.model = model
            self.elo_buckets = elo_buckets

        def forward(
            self,
            board: torch.Tensor,
            player_id: torch.Tensor,
            elo_oppo: torch.Tensor,
        ) -> torch.Tensor:
            return self.model(
                board, player_id + self.elo_buckets, elo_oppo
            )[0]

    export_model = PlayerIdInferenceModel(base_model, number_of_elo_buckets).eval()
    example_board = torch.zeros((1, 18, 8, 8), dtype=torch.float32, device=device)
    example_player = torch.zeros((1,), dtype=torch.long, device=device)
    example_opponent = torch.full((1,), 5, dtype=torch.long, device=device)
    with torch.no_grad():
        torch.onnx.export(
            export_model,
            (example_board, example_player, example_opponent),
            str(player_model_path),
            input_names=["board", "player_id", "elo_oppo"],
            output_names=["logits_maia"],
            dynamic_axes={
                "board": {0: "batch"},
                "player_id": {0: "batch"},
                "elo_oppo": {0: "batch"},
                "logits_maia": {0: "batch"},
            },
            opset_version=17,
            dynamo=False,
        )

    matcher_path: Path | None = None
    matcher_history: list[dict[str, float | int | None]] = []
    if number_of_players > 1:
        matcher_path, matcher_history = train_matcher(
            args=args,
            torch=torch,
            nn=nn,
            DataLoader=DataLoader,
            TensorDataset=TensorDataset,
            move_to_index=move_to_index,
            move_vocab_size=len(move_vocab),
            output_dir=args.output_dir,
            players=dataset_manifest["players"],
            train_rows=train_rows,
            validation_rows=validation_rows,
        )

    report = {
        "version": 1,
        "players": dataset_manifest["players"],
        "training": {
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "scheduler": "cosine_annealing",
            "unfrozen_module": "chess_cnn.layers[-1]",
            "early_stopping_patience": args.early_stopping_patience,
            "best_epoch": best_epoch or None,
            "best_validation_top1": (
                best_validation_top1 if best_model_state is not None else None
            ),
            "stopped_early": stopped_early,
            "device": str(device),
            "train_positions": len(train_dataset),
            "validation_positions": len(validation_dataset)
            if validation_dataset is not None
            else 0,
            "history": history,
        },
        "model": player_model_path.name,
        "prototype_matcher": matcher_path.name if matcher_path else None,
        "matcher_window_size": args.matcher_window_size,
        "matcher_opening_plies": args.matcher_opening_plies,
        "matcher_dropout": args.matcher_dropout,
        "matcher_weight_decay": args.matcher_weight_decay,
        "matcher_minimum_games": args.matcher_minimum_games,
        "matcher_maximum_games": args.matcher_maximum_games,
        "matcher_history": matcher_history,
        "board_dtype": "float32",
        "move_vocabulary_size": len(move_vocab),
    }
    (args.output_dir / "maia4all_manifest.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_dir / "training_report.json").write_text(
        json.dumps(report["training"], indent=2) + "\n", encoding="utf-8"
    )
    print(f"Exported player-conditioned Maia model: {player_model_path}")
    if matcher_path:
        print(f"Exported prototype matcher: {matcher_path}")


def train_matcher(
    args: argparse.Namespace,
    torch: Any,
    nn: Any,
    DataLoader: Any,
    TensorDataset: Any,
    move_to_index: dict[str, int],
    move_vocab_size: int,
    output_dir: Path,
    players: list[dict[str, Any]],
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
) -> tuple[Path | None, list[dict[str, float | int | None]]]:
    import numpy as np

    class PrototypeMatcher(nn.Module):
        def __init__(self, number_of_moves: int, number_of_players: int) -> None:
            super().__init__()
            self.move_embedding = nn.Embedding(
                number_of_moves + 1, 64, padding_idx=0
            )
            self.sequence_encoder = nn.GRU(64, 128, batch_first=True)
            self.dropout = nn.Dropout(args.matcher_dropout)
            self.output = nn.Linear(128, number_of_players)

        def forward(self, profile_move_ids: Any) -> Any:
            batch_size, game_count, moves_per_game = profile_move_ids.shape
            move_ids = profile_move_ids.reshape(
                batch_size * game_count, moves_per_game
            )
            embedded = self.move_embedding(move_ids)
            encoded, _ = self.sequence_encoder(embedded)
            lengths = (move_ids != 0).sum(dim=1).clamp(min=1)
            last_indices = (lengths - 1).view(-1, 1, 1)
            last_indices = last_indices.expand(-1, 1, encoded.size(-1))
            game_states = encoded.gather(1, last_indices).squeeze(1)
            profile_state = game_states.reshape(
                batch_size, game_count, -1
            ).mean(dim=1)
            return self.output(self.dropout(profile_state))

    train_sequences, train_labels = build_profile_move_sequences(
        train_rows,
        move_to_index,
        args.matcher_window_size,
        args.matcher_history_games,
        args.matcher_opening_plies,
    )
    validation_sequences, validation_labels = build_profile_move_sequences(
        validation_rows,
        move_to_index,
        args.matcher_window_size,
        args.matcher_history_games,
        args.matcher_opening_plies,
    )
    if not train_sequences:
        raise ValueError(
            "The selected prototypes do not have enough training moves to train the matcher."
        )

    device = torch.device(
        args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    )

    def tensor_dataset(
        sequences: list[list[list[int]]], labels: list[int]
    ) -> Any:
        if not sequences:
            return None
        return TensorDataset(
            torch.tensor(np.asarray(sequences), dtype=torch.long),
            torch.tensor(labels, dtype=torch.long),
        )

    train_dataset = tensor_dataset(train_sequences, train_labels)
    validation_dataset = tensor_dataset(validation_sequences, validation_labels)
    train_loader = DataLoader(
        train_dataset, batch_size=args.batch_size, shuffle=True, num_workers=0
    )
    validation_loader = (
        DataLoader(
            validation_dataset,
            batch_size=args.batch_size,
            shuffle=False,
            num_workers=0,
        )
        if validation_dataset is not None
        else None
    )
    matcher = PrototypeMatcher(move_vocab_size, len(players)).to(device)
    optimizer = torch.optim.Adam(
        matcher.parameters(),
        lr=args.matcher_learning_rate,
        weight_decay=args.matcher_weight_decay,
    )
    criterion = nn.CrossEntropyLoss()
    history: list[dict[str, float | int | None]] = []
    best_matcher_state: dict[str, Any] | None = None
    best_matcher_accuracy = -1.0
    best_matcher_epoch = 0
    matcher_epochs_without_improvement = 0
    matcher_stopped_early = False

    for epoch in range(args.matcher_epochs):
        matcher.train()
        loss_total = 0.0
        correct = 0
        seen = 0
        for move_ids, labels in train_loader:
            move_ids = move_ids.to(device)
            move_ids = shuffle_profile_game_order(move_ids, torch)
            labels = labels.to(device)
            logits = matcher(move_ids)
            loss = criterion(logits, labels)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            loss_total += loss.item() * labels.size(0)
            correct += (logits.argmax(dim=-1) == labels).sum().item()
            seen += labels.size(0)
        metrics: dict[str, float | int | None] = {
            "epoch": epoch + 1,
            "training_loss": loss_total / seen,
            "training_accuracy": correct / seen,
            "validation_accuracy": None,
        }
        if validation_loader is not None:
            matcher.eval()
            validation_correct = 0
            validation_seen = 0
            with torch.no_grad():
                for move_ids, labels in validation_loader:
                    logits = matcher(move_ids.to(device))
                    labels = labels.to(device)
                    validation_correct += (
                        logits.argmax(dim=-1) == labels
                    ).sum().item()
                    validation_seen += labels.size(0)
            validation_accuracy = validation_correct / validation_seen
            metrics["validation_accuracy"] = validation_accuracy
            if validation_accuracy > best_matcher_accuracy:
                best_matcher_accuracy = validation_accuracy
                best_matcher_epoch = epoch + 1
                best_matcher_state = {
                    name: tensor.detach().cpu().clone()
                    for name, tensor in matcher.state_dict().items()
                }
                matcher_epochs_without_improvement = 0
            else:
                matcher_epochs_without_improvement += 1
        history.append(metrics)
        print(json.dumps({"matcher": metrics}, sort_keys=True))
        if (
            validation_loader is not None
            and matcher_epochs_without_improvement >= args.early_stopping_patience
        ):
            matcher_stopped_early = True
            print(
                json.dumps(
                    {
                        "matcher_early_stopping": True,
                        "best_epoch": best_matcher_epoch,
                        "best_validation_accuracy": best_matcher_accuracy,
                    },
                    sort_keys=True,
                )
            )
            break

    matcher_path = output_dir / "maia4all_pmn.onnx"
    if best_matcher_state is not None:
        matcher.load_state_dict(best_matcher_state)
    torch.save(matcher.state_dict(), output_dir / "prototype_matcher.pt")
    matcher.eval()
    example_moves = torch.zeros(
        (1, args.matcher_history_games, args.matcher_window_size),
        dtype=torch.long,
        device=device,
    )
    with torch.no_grad():
        torch.onnx.export(
            matcher,
            (example_moves,),
            str(matcher_path),
            input_names=["profile_move_ids"],
            output_names=["player_logits"],
            dynamic_axes={
                "profile_move_ids": {0: "batch", 1: "games"},
                "player_logits": {0: "batch"},
            },
            opset_version=17,
            dynamo=False,
        )
    if history:
        history[-1]["best_epoch"] = best_matcher_epoch or None
        history[-1]["best_validation_accuracy"] = (
            best_matcher_accuracy if best_matcher_state is not None else None
        )
        history[-1]["stopped_early"] = matcher_stopped_early
    return matcher_path, history


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--maia-model-dir", type=Path)
    parser.add_argument("--move-vocab", type=Path, default=MOVE_VOCAB_PATH)
    parser.add_argument("--players", nargs="+")
    parser.add_argument(
        "--roster-manifest",
        type=Path,
        help="Use the ordered player roster produced by collect_lichess.py.",
    )
    parser.add_argument("--max-players", type=int, default=5)
    parser.add_argument("--max-games-per-player", type=int, default=100)
    parser.add_argument("--max-positions-per-player", type=int, default=10_000)
    parser.add_argument("--validation-fraction", type=float, default=0.2)
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--early-stopping-patience", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--matcher-epochs", type=int, default=10)
    parser.add_argument("--matcher-learning-rate", type=float, default=1e-3)
    parser.add_argument("--matcher-weight-decay", type=float, default=1e-4)
    parser.add_argument("--matcher-dropout", type=float, default=0.5)
    parser.add_argument("--matcher-opening-plies", type=int, default=12)
    parser.add_argument("--matcher-window-size", type=int, default=16)
    parser.add_argument("--matcher-history-games", type=int, default=20)
    parser.add_argument("--matcher-minimum-games", type=int, default=20)
    parser.add_argument("--matcher-maximum-games", type=int, default=50)
    parser.add_argument("--device", choices=["cpu", "cuda"])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args(argv)
    if args.max_players < 1 or args.max_games_per_player < 1:
        parser.error("Player and game limits must be positive.")
    if args.epochs < 1 or args.matcher_epochs < 1:
        parser.error("Training epoch counts must be positive.")
    if args.early_stopping_patience < 1:
        parser.error("Early-stopping patience must be positive.")
    if args.batch_size < 1:
        parser.error("Batch size must be positive.")
    if args.learning_rate <= 0 or args.matcher_learning_rate <= 0:
        parser.error("Learning rates must be positive.")
    if args.matcher_weight_decay < 0:
        parser.error("Matcher weight decay must be non-negative.")
    if not 0 <= args.matcher_dropout < 1:
        parser.error("Matcher dropout must be in the range [0, 1).")
    if args.matcher_opening_plies < 0:
        parser.error("Matcher opening plies must be non-negative.")
    if args.matcher_window_size < 1:
        parser.error("Matcher window size must be positive.")
    if not (
        1 <= args.matcher_minimum_games <= args.matcher_history_games
        <= args.matcher_maximum_games
    ):
        parser.error(
            "Matcher game counts must satisfy 1 <= minimum <= history <= maximum."
        )
    return args


if __name__ == "__main__":
    run_training(parse_args())
