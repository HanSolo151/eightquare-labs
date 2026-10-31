import assert from "node:assert/strict";
import { calculateStyleVector } from "@/lib/maia/styleVector";

const moves = [
  "e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3", "Bc5", "c3", "d6",
  "O-O", "O-O", "Re1", "a6", "Bb3", "Ba7", "h3", "h6", "d4", "exd4",
  "cxd4", "a5", "Nc3", "b6", "Re2", "Ba6", "e5", "Ne4",
];
assert.equal(calculateStyleVector([{ playerColor: "white", moves }])?.length, 6);
assert.equal(calculateStyleVector([{ playerColor: "black", moves }])?.length, 6);
console.log("Style-vector shape checks passed.");
