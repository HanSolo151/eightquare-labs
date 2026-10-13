/// <reference lib="webworker" />
import * as ort from "onnxruntime-web";
import { boardToTensor, mirrorUci } from "../../lib/maia/boardToTensor";
import { eloToBucket } from "../../lib/maia/eloBuckets";
import { indexToUci, loadMoveVocab } from "../../lib/maia/moveVocab";

type InferenceRequest = {
  id: string;
  fen: string;
  selfRating: number | null;
  oppRating: number | null;
};

type InferenceResponse =
  | { id: string; ok: true; topMoveIndex: number; topMoveUci: string; logitsMaia: Float32Array }
  | { id: string; ok: false; error: string };

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    // fp16 model — confirmed at public/models/ per Step 1.
    sessionPromise = ort.InferenceSession.create("/models/maia2_rapid_fp16.onnx", {
      executionProviders: ["wasm"],
    });
  }
  return sessionPromise;
}

self.onmessage = async (e: MessageEvent<InferenceRequest>) => {
  const { id, fen, selfRating, oppRating } = e.data;

  try {
    const session = await getSession();

    // IMPORTANT (Step 1, item 20): fp16 model expects the board input as
    // float16, not float32. onnxruntime-web has no native Float16Array,
    // so we pack via Uint16Array using ort's float16 helper.
    const boardF32 = boardToTensor(fen);
    
    const boardF16Bits = float32ArrayToFloat16Bits(boardF32);

    const boardTensor = new ort.Tensor("float16", boardF16Bits, [1, 18, 8, 8]);

    const selfBucket = eloToBucket(selfRating);
    const oppBucket = eloToBucket(oppRating);

    const elosSelfTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(selfBucket)]), [1]);
    const elosOppoTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(oppBucket)]), [1]);

    const feeds: Record<string, ort.Tensor> = {
      board: boardTensor,
      elo_self: elosSelfTensor,
      elo_oppo: elosOppoTensor,
    };

    const results = await session.run(feeds);
    const logitsMaia = results["logits_maia"].data as Float32Array;

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

    const response: InferenceResponse = {
      id,
      ok: true,
      topMoveIndex,
      topMoveUci,
      logitsMaia,
    }; 

    
    console.log("posting response:", JSON.stringify({ ...response, logitsMaia: "[omitted]" }));
    self.postMessage(response);
  } catch (err) {
    const response: InferenceResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    
    self.postMessage(response);
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