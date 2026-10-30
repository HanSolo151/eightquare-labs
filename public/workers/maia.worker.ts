/// <reference lib="webworker" />
import * as ort from "onnxruntime-web";
import { boardToTensor, mirrorUci } from "../../lib/maia/boardToTensor";
import { eloToBucket } from "../../lib/maia/eloBuckets";
import { indexToUci, loadMoveVocab } from "../../lib/maia/moveVocab";

type InferenceRequest = {
  type: "infer";
  id: string;
  fen: string;
  selfRating: number | null;
  oppRating: number | null;
  playerId?: number;
};

type MatchRequest = {
  type: "match";
  id: string;
  gameMoveUcis: string[][];
  playerName?: string | null;
};

type WorkerRequest = InferenceRequest | MatchRequest;

type PrototypeManifest = {
  version: 1;
  model: string;
  prototype_matcher: string | null;
  matcher_window_size: number;
  matcher_minimum_moves?: number;
  matcher_minimum_games?: number;
  matcher_maximum_games?: number;
  board_dtype: "float32";
  players: Array<{ id: number; name: string }>;
};

type WorkerResponse =
  | {
      type: "infer";
      id: string;
      ok: true;
      topMoveIndex: number;
      topMoveUci: string;
      logitsMaia: Float32Array;
    }
  | {
      type: "match";
      id: string;
      ok: true;
      match: { playerId: number; confidence: number } | null;
    }
  | { type: WorkerRequest["type"]; id: string; ok: false; error: string };

const BASE_MODEL_PATH = "/models/maia2_rapid_fp16.onnx";
const MANIFEST_PATH = "/models/maia4all_manifest.json";
const sessionPromises = new Map<string, Promise<ort.InferenceSession>>();
let manifestPromise: Promise<PrototypeManifest | null> | null = null;

function getSession(modelPath: string): Promise<ort.InferenceSession> {
  let sessionPromise = sessionPromises.get(modelPath);
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["wasm"],
    });
    sessionPromises.set(modelPath, sessionPromise);
  }
  return sessionPromise;
}

function isModelFilename(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.onnx$/i.test(value);
}

function parseManifest(value: unknown): PrototypeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Maia4All model manifest must be an object.");
  }
  const candidate = value as Partial<PrototypeManifest>;
  if (
    candidate.version !== 1 ||
    !isModelFilename(candidate.model) ||
    (candidate.prototype_matcher !== null &&
      !isModelFilename(candidate.prototype_matcher)) ||
    candidate.board_dtype !== "float32" ||
    !Number.isInteger(candidate.matcher_window_size) ||
    (candidate.matcher_window_size ?? 0) < 1 ||
    (candidate.matcher_minimum_games === undefined
      ? !Number.isInteger(candidate.matcher_minimum_moves) ||
        (candidate.matcher_minimum_moves ?? 0) < 1 ||
        (candidate.matcher_minimum_moves ?? 0) >
          (candidate.matcher_window_size ?? 0)
      : !Number.isInteger(candidate.matcher_minimum_games) ||
        !Number.isInteger(candidate.matcher_maximum_games) ||
        (candidate.matcher_minimum_games ?? 0) < 1 ||
        (candidate.matcher_maximum_games ?? 0) <
          (candidate.matcher_minimum_games ?? 0)),
    !Array.isArray(candidate.players) ||
    candidate.players.length === 0 ||
    !candidate.players.every(
      (player, index) =>
        player &&
        Number.isInteger(player.id) &&
        player.id === index &&
        typeof player.name === "string" &&
        player.name.length > 0
    )
  ) {
    throw new Error("Maia4All model manifest has an unsupported or invalid shape.");
  }
  return candidate as PrototypeManifest;
}

function getManifest(): Promise<PrototypeManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_PATH).then(async (response) => {
      if (response.status === 404) {
        console.info("No Maia4All model manifest; using rating-conditioned Maia-2.");
        return null;
      }
      if (!response.ok) {
        throw new Error(`Failed to load Maia4All model manifest: ${response.status}`);
      }
      return parseManifest(await response.json());
    });
  }
  return manifestPromise;
}

function eloTensor(rating: number | null): ort.Tensor {
  return new ort.Tensor(
    "int64",
    BigInt64Array.from([BigInt(eloToBucket(rating))]),
    [1]
  );
}

async function infer(request: InferenceRequest): Promise<WorkerResponse> {
  const { id, fen, selfRating, oppRating, playerId } = request;
  const manifest = playerId === undefined ? null : await getManifest();
  if (playerId !== undefined && manifest === null) {
    throw new Error("A player ID was supplied, but no Maia4All model is installed.");
  }
  if (
    manifest &&
    (playerId === undefined ||
      !Number.isInteger(playerId) ||
      playerId < 0 ||
      playerId >= manifest.players.length)
  ) {
    throw new Error(`Unknown Maia4All player ID: ${playerId}.`);
  }

  const personalized = manifest !== null;
  const modelPath = manifest ? `/models/${manifest.model}` : BASE_MODEL_PATH;
  const session = await getSession(modelPath);
  if (personalized && !session.inputNames.includes("player_id")) {
    throw new Error("The installed Maia4All ONNX model does not accept player_id.");
  }

  const boardF32 = boardToTensor(fen);
  const feeds: Record<string, ort.Tensor> = {};
  if (manifest) {
    if (playerId === undefined) {
      throw new Error("A Maia4All request must include a player ID.");
    }
    feeds.board = new ort.Tensor("float32", boardF32, [1, 18, 8, 8]);
    feeds.player_id = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(playerId)]),
      [1]
    );
    feeds.elo_oppo = eloTensor(oppRating);
  } else {
    // The checked-in Maia-2 model expects a float16 board input.
    feeds.board = new ort.Tensor(
      "float16",
      float32ArrayToFloat16Bits(boardF32),
      [1, 18, 8, 8]
    );
    feeds.elo_self = eloTensor(selfRating);
    feeds.elo_oppo = eloTensor(oppRating);
  }

  const results = await session.run(feeds);
  const logitsMaia = results["logits_maia"]?.data;
  if (!(logitsMaia instanceof Float32Array) || logitsMaia.length === 0) {
    throw new Error("Maia ONNX returned invalid move logits.");
  }

  let topIdx = 0;
  let topVal = -Infinity;
  for (let i = 0; i < logitsMaia.length; i++) {
    if (logitsMaia[i] > topVal) {
      topVal = logitsMaia[i];
      topIdx = i;
    }
  }

  const modelTopMoveUci = await indexToUci(topIdx);
  const blackToMove = fen.split(" ")[1] === "b";
  const topMoveUci = blackToMove ? mirrorUci(modelTopMoveUci) : modelTopMoveUci;
  const topMoveIndex = blackToMove
    ? (await loadMoveVocab()).indexOf(topMoveUci)
    : topIdx;
  if (topMoveIndex < 0) {
    throw new Error(`Mirrored Maia move is missing from the vocabulary: ${topMoveUci}`);
  }

  return {
    type: "infer",
    id,
    ok: true,
    topMoveIndex,
    topMoveUci,
    logitsMaia,
  };
}

async function matchPrototype(request: MatchRequest): Promise<WorkerResponse> {
  const manifest = await getManifest();
  if (!manifest) {
    return { type: "match", id: request.id, ok: true, match: null };
  }
  const namedPrototype = manifest.players.find(
    (player) =>
      request.playerName?.trim().toLowerCase() === player.name.trim().toLowerCase()
  );
  if (namedPrototype) {
    return {
      type: "match",
      id: request.id,
      ok: true,
      match: { playerId: namedPrototype.id, confidence: 1 },
    };
  }
  if (manifest.players.length === 1) {
    return { type: "match", id: request.id, ok: true, match: null };
  }
  if (!manifest.prototype_matcher) {
    throw new Error("The Maia4All manifest has no prototype matching model.");
  }
  const maximumGames = manifest.matcher_maximum_games;
  const minimumGames = manifest.matcher_minimum_games;
  const minimumMoves = manifest.matcher_minimum_moves;
  if (minimumGames !== undefined && maximumGames === undefined) {
    throw new Error("The prototype matcher game-count manifest is incomplete.");
  }
  const gameMoves = minimumGames !== undefined
    ? request.gameMoveUcis.slice(-(maximumGames ?? 0))
    : [];
  const legacyMoves = minimumGames === undefined
    ? request.gameMoveUcis.flat()
    : [];
  if (
    (minimumGames !== undefined && gameMoves.length < minimumGames) ||
    (minimumGames === undefined &&
      (minimumMoves === undefined ||
        legacyMoves.length < minimumMoves))
  ) {
    return { type: "match", id: request.id, ok: true, match: null };
  }

  const vocab = await loadMoveVocab();
  const session = await getSession(`/models/${manifest.prototype_matcher}`);
  let results: ort.InferenceSession.OnnxValueMapType;
  if (minimumGames !== undefined) {
    const paddedMoveIds = new BigInt64Array(
      gameMoves.length * manifest.matcher_window_size,
    );
    for (let gameIndex = 0; gameIndex < gameMoves.length; gameIndex++) {
      const moveIds = gameMoves[gameIndex]
        .slice(-manifest.matcher_window_size)
        .map((uci) => {
          const index = vocab.indexOf(uci);
          if (index < 0) {
            throw new Error(`Observed move is missing from Maia's vocabulary: ${uci}`);
          }
          return index + 1;
        });
      for (let moveIndex = 0; moveIndex < moveIds.length; moveIndex++) {
        paddedMoveIds[
          gameIndex * manifest.matcher_window_size + moveIndex
        ] = BigInt(moveIds[moveIndex]);
      }
    }
    results = await session.run({
      profile_move_ids: new ort.Tensor(
        "int64",
        paddedMoveIds,
        [1, gameMoves.length, manifest.matcher_window_size],
      ),
    });
  } else {
    const moveIds = legacyMoves
      .slice(-manifest.matcher_window_size)
      .map((uci) => {
        const index = vocab.indexOf(uci);
        if (index < 0) {
          throw new Error(`Observed move is missing from Maia's vocabulary: ${uci}`);
        }
        return index + 1;
      });
    const paddedMoveIds = new BigInt64Array(manifest.matcher_window_size);
    for (let index = 0; index < moveIds.length; index++) {
      paddedMoveIds[index] = BigInt(moveIds[index]);
    }
    results = await session.run({
      move_ids: new ort.Tensor(
        "int64",
        paddedMoveIds,
        [1, manifest.matcher_window_size],
      ),
    });
  }
  const logits = results["player_logits"]?.data;
  if (!(logits instanceof Float32Array) || logits.length !== manifest.players.length) {
    throw new Error("Prototype matcher returned logits with an unexpected size.");
  }
  let maxLogit = -Infinity;
  let playerIndex = 0;
  for (let index = 0; index < logits.length; index++) {
    if (!Number.isFinite(logits[index])) {
      throw new Error(`Prototype matcher returned a non-finite logit at index ${index}.`);
    }
    if (logits[index] > maxLogit) {
      maxLogit = logits[index];
      playerIndex = index;
    }
  }
  let denominator = 0;
  for (const logit of logits) denominator += Math.exp(logit - maxLogit);
  const confidence = 1 / denominator;
  return {
    type: "match",
    id: request.id,
    ok: true,
    match: { playerId: manifest.players[playerIndex].id, confidence },
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const response = request.type === "infer"
      ? await infer(request)
      : await matchPrototype(request);
    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      type: request.type,
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Minimal float32 -> IEEE 754 float16 bit converter.
function float32ArrayToFloat16Bits(arr: Float32Array): Uint16Array {
  const out = new Uint16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = float32ToFloat16Bits(arr[i]);
  }
  return out;
}

function float32ToFloat16Bits(val: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = val;
  const x = int32View[0];

  let bits = (x >> 16) & 0x8000; // sign
  let m = (x >> 12) & 0x07ff; // mantissa
  const e = (x >> 23) & 0xff; // exponent

  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && (x & 0x007fffff ? 1 : 0) ? 0x200 : 0;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}