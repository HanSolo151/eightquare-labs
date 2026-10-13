// Run with: npx tsx scripts/testFloat16Parity.ts
//
// Purpose: isolate boardToTensor() + float32ToFloat16Bits() from the worker
// and DOM context, so we can sanity-check them in plain Node before trusting
// them inside the Web Worker. This does NOT call onnxruntime — it only
// checks that our hand-rolled tensor encoding + fp16 packing produce sane,
// correctly-shaped output. True numerical parity against Step 1's Python
// fp16 diffs requires comparing against the actual bytes PyTorch/onnxconverter
// produced, which isn't available here — see note at bottom.

// NOTE: this test file is unaffected by the row-indexing bug below — it only
// checks fp16 round-trip losslessness, not placement correctness. See the
// boardToTensor.ts fix delivered alongside this for the actual bug.
import { boardToTensor, mirrorFen, mirrorUci } from "../lib/maia/boardToTensor";

// --- duplicated from maia.worker.ts so this can run standalone in Node ---
function float32ToFloat16Bits(val: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = val;
  const x = int32View[0];

  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;

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

// Reference decoder (fp16 bits -> JS number) so we can round-trip and check
// the packer isn't silently corrupting values.
function float16BitsToFloat32(bits: number): number {
  const sign = (bits & 0x8000) >> 15;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
  } else if (exponent === 0x1f) {
    return fraction ? NaN : (sign ? -Infinity : Infinity);
  }
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

const REFERENCE_FENS: Record<string, string> = {
  "starting position": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "early midgame": "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  "endgame (K+R)": "8/8/4k3/8/8/4K3/8/4R3 w - - 0 1",
  "developed midgame": "r2qkb1r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 4 6",
};

const STARTING_FEN_BLACK = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
const STARTING_FEN_WHITE = REFERENCE_FENS["starting position"];
const ASYMMETRIC_BLACK_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const ASYMMETRIC_MIRRORED_FEN = "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let allPassed = true;

for (const [label, fen] of Object.entries(REFERENCE_FENS)) {
  console.log(`\n=== ${label} ===`);
  console.log(`FEN: ${fen}`);

  const tensor = boardToTensor(fen);

  // Sanity checks on the raw float32 tensor before we even touch fp16.
  if (tensor.length !== 18 * 8 * 8) {
    console.error(`  FAIL: tensor length ${tensor.length}, expected ${18 * 8 * 8}`);
    allPassed = false;
    continue;
  }

  // Regression check for a row-indexing bug: white's back rank (rank 1) must
  // land in tensor row 0, matching Python's `row, col = divmod(square, 8)`
  // (square 0 = a1 -> row 0). If this ever flips, every piece is mirrored
  // vertically and predictions will be silently wrong.
  if (fen === REFERENCE_FENS["starting position"]) {
    const whiteRookChannel = 3; // wr
    const a1Index = whiteRookChannel * 64 + 0 * 8 + 0; // row 0, file a
    const a8Index = whiteRookChannel * 64 + 7 * 8 + 0; // row 7, file a
    if (tensor[a1Index] !== 1.0 || tensor[a8Index] !== 0.0) {
      console.error(
        `  FAIL: white rook row mapping wrong — expected row 0 (rank 1) to hold the white rook, got row0=${tensor[a1Index]} row7=${tensor[a8Index]}`
      );
      allPassed = false;
    } else {
      console.log("  PASS: rank-1/row-0 mapping correct (white rook found on row 0, not row 7)");
    }
  }

  const sideToMovePlane = tensor.slice(12 * 64, 13 * 64);
  const sideToMoveVal = sideToMovePlane[0];
  const sideToMoveConsistent = sideToMovePlane.every((v) => v === sideToMoveVal);
  console.log(`  side-to-move plane: ${sideToMoveVal} (consistent: ${sideToMoveConsistent})`);
  if (!sideToMoveConsistent) {
    console.error("  FAIL: side-to-move plane is not uniform");
    allPassed = false;
  }

  // Count occupied squares across channels 0-11, should be 2-32 for any legal position.
  let pieceCount = 0;
  for (let c = 0; c < 12; c++) {
    for (let i = 0; i < 64; i++) {
      if (tensor[c * 64 + i] === 1.0) pieceCount++;
    }
  }
  console.log(`  piece count from tensor: ${pieceCount}`);

  // Round-trip every value through the fp16 packer and check max abs diff
  // against the original float32 — this isolates the packer's own error,
  // separate from onnx/model error.
  let maxDiff = 0;
  for (let i = 0; i < tensor.length; i++) {
    const bits = float32ToFloat16Bits(tensor[i]);
    const roundTripped = float16BitsToFloat32(bits);
    const diff = Math.abs(roundTripped - tensor[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  console.log(`  fp16 round-trip max abs diff: ${maxDiff}`);
  // Our tensor only ever contains 0.0 or 1.0 values (no continuous weights),
  // and both are exactly representable in fp16, so this MUST be 0.
  if (maxDiff !== 0) {
    console.error(`  FAIL: expected exact round-trip for 0/1 values, got diff ${maxDiff}`);
    allPassed = false;
  } else {
    console.log("  PASS: exact round-trip (expected, since inputs are only 0.0/1.0)");
  }
}

console.log("\n=== Maia canonical orientation: Black to move ===");
const mirroredBlackFen = mirrorFen(STARTING_FEN_BLACK);
if (mirroredBlackFen !== STARTING_FEN_WHITE) {
  console.error(`FAIL: mirrored start FEN mismatch: ${mirroredBlackFen}`);
  allPassed = false;
} else if (boardToTensor(STARTING_FEN_BLACK).some((value, i) => value !== boardToTensor(STARTING_FEN_WHITE)[i])) {
  console.error("FAIL: Black-to-move starting tensor does not match Maia's canonical White-to-move tensor");
  allPassed = false;
} else {
  console.log("PASS: Black-to-move starting board mirrors to Maia's canonical starting tensor");
}

const asymmetricMirror = mirrorFen(ASYMMETRIC_BLACK_FEN);
const blackTensor = boardToTensor(ASYMMETRIC_BLACK_FEN);
const expectedCanonicalTensor = boardToTensor(ASYMMETRIC_MIRRORED_FEN);
if (
  asymmetricMirror !== ASYMMETRIC_MIRRORED_FEN ||
  blackTensor.some((value, i) => value !== expectedCanonicalTensor[i]) ||
  mirrorFen(asymmetricMirror) !== ASYMMETRIC_BLACK_FEN
) {
  console.error(`FAIL: asymmetric Black-to-move mirror mismatch: ${asymmetricMirror}`);
  allPassed = false;
} else {
  console.log("PASS: asymmetric Black-to-move board, tensor, and inverse mirror all match");
}

if (mirrorUci("e7e5") !== "e2e4" || mirrorUci(mirrorUci("e7e5")) !== "e7e5") {
  console.error("FAIL: UCI rank-mirror conversion is incorrect");
  allPassed = false;
} else {
  console.log("PASS: Black UCI moves map to canonical coordinates and back");
}

console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
console.log(`
NOTE: this validates (a) tensor shape/structure and (b) that the fp16 packer
is lossless for the 0.0/1.0 values boardToTensor() actually produces. It does
NOT validate against Step 1's Python-side fp16 diffs (7.15e-06 etc.), because
those numbers came from PyTorch's internal weights being cast to fp16, not
from this board-input packer — Step 1 item 20 only required the board INPUT
to be cast correctly, and since inputs are binary 0/1, any correct fp16
packer is exact here by construction. The real end-to-end check is: run this
tensor through the actual ONNX session in the browser and compare the
resulting top move index against Python's (Step 1 item 17: index 169 for the
starting position). That requires the live worker + onnxruntime-web, not
Node — see testMaiaWorker.ts for that, which I'll write next once you confirm
this one runs clean.
`);