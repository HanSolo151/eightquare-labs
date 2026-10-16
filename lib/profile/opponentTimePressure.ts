import { fetchGames } from "../lichess/fetchGames";
import { parseGames } from "../lichess/parseGame";
import { extractAllMoveFeatures, buildPlayerProfile } from "../features/extractFeatures";
import { evalGame } from "../eval/evalCache";
import { resolveCpLoss, TIME_RATIO_COLLAPSE_THRESHOLD, MIN_CP_LOSS } from "../flags/flagEngine";
import { getTimePressureProfile, saveTimePressureProfile } from "./timePressureProfileCache";
import type { OpponentTimePressureProfile, GamePhase, ParsedGame } from "@/types";

const MAX_OPPONENT_GAMES = 20;
const PHASES: GamePhase[] = ["opening", "middlegame", "endgame"];
const MEDIUM_SAMPLE = 5;
const HIGH_SAMPLE = 15;

export function emptyTimePressureProfile(username: string): OpponentTimePressureProfile {
  const byPhase = {} as OpponentTimePressureProfile["byPhase"];
  for (const phase of PHASES) {
    byPhase[phase] = { phaseAvgSec: null, sampleSize: 0, collapseCount: 0, collapseRate: 0, confidence: "low" };
  }
  return { username, gamesAnalyzed: 0, evaluatedGameIds: [], byPhase };
}

export async function buildOpponentTimePressureProfile(
  opponentUsername: string,
  onProgress?: (done: number, total: number) => void,
  providedGames?: ParsedGame[]
): Promise<OpponentTimePressureProfile> {
  const cached = await getTimePressureProfile(opponentUsername);
  const profile = cached ?? emptyTimePressureProfile(opponentUsername);
  const games = providedGames ?? parseGames(
    await fetchGames({ username: opponentUsername, max: MAX_OPPONENT_GAMES, rated: true, perfType: "rapid" }),
    opponentUsername
  );
  const allFeatures = extractAllMoveFeatures(games);
  const basicProfile = buildPlayerProfile(opponentUsername, games, allFeatures);
  const toEvaluate = games.filter((game) => !profile.evaluatedGameIds.includes(game.id));

  for (let i = 0; i < toEvaluate.length; i++) {
    const game = toEvaluate[i];
    try {
      const gameEval = await evalGame(game.id, game.moves);
      const evalByPly = new Map(gameEval.points.map((point) => [point.ply, point]));
      const ownMoves = allFeatures.filter((feature) => feature.gameId === game.id && feature.color === game.playerColor);
      for (const move of ownMoves) {
        if (move.likelyPremove || move.timeSpentSec === null) continue;
        const phaseAvg = basicProfile.avgMoveTimeSecByPhase[move.gamePhase];
        if (phaseAvg === null || phaseAvg === 0) continue;
        const evalPoint = evalByPly.get(move.ply);
        if (!evalPoint) continue;
        const resolved = resolveCpLoss(evalPoint);
        if (!resolved) continue;
        const timeRatio = move.timeSpentSec / phaseAvg;
        const bucket = profile.byPhase[move.gamePhase];
        bucket.sampleSize++;
        if (timeRatio < TIME_RATIO_COLLAPSE_THRESHOLD && resolved.cpLoss >= MIN_CP_LOSS) bucket.collapseCount++;
      }
      profile.evaluatedGameIds.push(game.id);
    } catch (err) {
      console.error("Skipping opponent game in time-pressure build:", game.id, err);
    }
    onProgress?.(i + 1, toEvaluate.length);
  }

  for (const phase of PHASES) {
    const bucket = profile.byPhase[phase];
    bucket.phaseAvgSec = basicProfile.avgMoveTimeSecByPhase[phase];
    bucket.collapseRate = bucket.sampleSize > 0 ? bucket.collapseCount / bucket.sampleSize : 0;
    bucket.confidence = bucket.sampleSize >= HIGH_SAMPLE ? "high" : bucket.sampleSize >= MEDIUM_SAMPLE ? "medium" : "low";
  }
  profile.gamesAnalyzed = games.length;
  await saveTimePressureProfile(profile);
  return profile;
}
