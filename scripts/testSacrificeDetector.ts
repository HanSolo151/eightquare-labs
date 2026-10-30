import assert from "node:assert/strict";
import { detectMaterialSacrifices } from "../lib/style/sacrificeDetector";
import type { EvalPoint, GameEval, ParsedGame } from "../types";

const moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Na5", "Nxe5", "Nxc4"];
const game: Pick<ParsedGame, "id" | "moves" | "playerColor"> = { id: "test-sac", moves, playerColor: "white" };

function evaluation(afterPlayerPovCp: number, depth = 16): GameEval {
  const points: EvalPoint[] = moves.map((_, ply) => ({
    ply,
    cpBefore: 100,
    cpAfter: 100,
    mateBefore: null,
    mateAfter: null,
    depth,
    bestMoveUci: null,
  }));
  // Ply 7 is Black's reply; EvalPoint scores are stored from the mover's POV.
  points[7] = { ...points[7], cpAfter: -afterPlayerPovCp };
  return { gameId: game.id, points, evaluatedAt: 0, engineVersion: "test" };
}

const compensated = detectMaterialSacrifices(game, evaluation(75));
assert.equal(compensated.length, 1);
assert.equal(compensated[0].ply, 6);
assert.equal(compensated[0].materialLostPawns, 2);
assert.equal(compensated[0].evalLossCp, 25);
assert.equal(compensated[0].outcome, "compensated");

const blunder = detectMaterialSacrifices(game, evaluation(-100));
assert.equal(blunder.length, 1);
assert.equal(blunder[0].evalLossCp, 200);
assert.equal(blunder[0].outcome, "blunder");

const uncertain = detectMaterialSacrifices(game, evaluation(25));
assert.equal(uncertain[0].outcome, "uncertain");

assert.deepEqual(detectMaterialSacrifices(game, evaluation(75, 7)), []);
const mateScores = evaluation(75);
mateScores.points[7] = { ...mateScores.points[7], cpAfter: null, mateAfter: -3 };
assert.deepEqual(detectMaterialSacrifices(game, mateScores), []);
assert.deepEqual(detectMaterialSacrifices({ ...game, id: "wrong-game" }, evaluation(75)), []);

console.log("Sacrifice detector checks passed: material loss, compensated offering, material blunder, uncertainty, shallow/mate exclusion, and game identity.");
