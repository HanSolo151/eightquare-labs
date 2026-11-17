export function normalizeMaiaLogits(data: unknown): Float32Array | null {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) {
    const logits = new Float32Array(data.length);
    for (let index = 0; index < data.length; index++) {
      logits[index] = float16BitsToFloat32(data[index]);
    }
    return logits;
  }
  if (isFloat16ValueArray(data)) return Float32Array.from(data);
  return null;
}

function isFloat16ValueArray(data: unknown): data is ArrayLike<number> {
  return ArrayBuffer.isView(data) &&
    data.constructor.name === "Float16Array" &&
    "length" in data &&
    typeof data.length === "number";
}

function float16BitsToFloat32(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;

  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
