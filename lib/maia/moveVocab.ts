// Loads the 1880-entry move vocabulary that logits_maia is indexed against.
// Source of truth: utils.get_all_possible_moves() from the maia2 package,
// dumped to JSON and verified length 1880. Index 169 = "g1f3", matching
// Step 1's Python-side validation (top move index 169 for the starting
// position) — this is a strong cross-check that the ordering is correct,
// though the real proof is the live ONNX test in testMaiaWorker.ts.
//
// IMPORTANT: this vocabulary is NOT reimplemented or regenerated in JS. It
// is loaded verbatim from the JSON file produced by the actual Python
// function. Never hand-edit public/data/move_vocab.json or regenerate it
// with a different method — any drift from the exact order the model was
// trained/exported against will silently make every move index wrong.

let vocabPromise: Promise<string[]> | null = null;

export function loadMoveVocab(): Promise<string[]> {
  if (!vocabPromise) {
    vocabPromise = fetch("/data/move_vocab.json")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch move_vocab.json: ${res.status}`);
        }
        return res.json();
      })
      .then((moves: string[]) => {
        if (moves.length !== 1880) {
          throw new Error(
            `move_vocab.json has ${moves.length} entries, expected 1880 — vocab file may be corrupt or wrong version`
          );
        }
        return moves;
      });
  }
  return vocabPromise;
}

/** Converts a logits_maia index into its UCI move string (e.g. "g1f3"). */
export async function indexToUci(index: number): Promise<string> {
  const vocab = await loadMoveVocab();
  const move = vocab[index];
  if (move === undefined) {
    throw new Error(`Move index ${index} out of range (vocab length ${vocab.length})`);
  }
  return move;
}