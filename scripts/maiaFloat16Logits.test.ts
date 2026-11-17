import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMaiaLogits } from "../lib/maia/float16Logits";

test("normalizes ONNX float16 bit logits to float32", () => {
  const logits = normalizeMaiaLogits(new Uint16Array([
    0x3c00,
    0xbc00,
    0x0001,
    0x7c00,
    0xfc00,
    0x7e00,
  ]));

  assert.ok(logits);
  assert.equal(logits[0], 1);
  assert.equal(logits[1], -1);
  assert.equal(logits[2], 2 ** -24);
  assert.equal(logits[3], Number.POSITIVE_INFINITY);
  assert.equal(logits[4], Number.NEGATIVE_INFINITY);
  assert.ok(Number.isNaN(logits[5]));
});

test("accepts float32 logits and rejects unsupported output data", () => {
  const logits = new Float32Array([1.25, -2.5]);
  assert.equal(normalizeMaiaLogits(logits), logits);
  assert.equal(normalizeMaiaLogits(new Int32Array([1, 2])), null);
});
