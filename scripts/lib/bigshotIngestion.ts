import { Prisma } from "@prisma/client";
import { Chess } from "chess.js";
import { MATCHING_CONFIG } from "../../config/matching";
import { normalizeStyleVector } from "../../lib/matching/computeGameVector";
import { PHASES, VECTOR_DIMENSIONS, type MatchPhase, type StyleVector } from "../../lib/matching/vectorSchema";
import type { ParsedGame } from "../../types";
import { BIGSHOT_SOURCE_TYPES, type BigshotSourceType } from "../../lib/matching/sourceTypes";

export interface BigshotConfig {
  enabled?: boolean;
  note?: string;
  name: string;
  aliases: string[];
  sourceType: BigshotSourceType;
  sourceRef: string;
  lichessUsername?: string;
  pgnPath?: string;
  pgnZipPath?: string;
  pgnUrl?: string;
  attribution?: string | null;
}

export interface SourceGame {
  pgn: string;
  sourceRef: string;
  sourceType: BigshotSourceType;
  attribution: string | null;
}

export interface AnalyzedGame {
  original: ParsedGame;
  pgn: string;
  sourceRef: string;
  sourceType: BigshotSourceType;
  attribution: string | null;
  vectors: Record<MatchPhase, StyleVector | null>;
  details: Record<MatchPhase, unknown>;
}

export interface PreparedBigshot {
  config: BigshotConfig;
  games: AnalyzedGame[];
}

export interface EligibleBigshot extends PreparedBigshot {
  byPhase: Record<MatchPhase, AnalyzedGame[]>;
}

export interface CorpusStats {
  mean: StyleVector;
  stdDev: StyleVector;
}

export function phaseAt(ply: number): MatchPhase {
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.openingEnd) return "opening";
  if (ply < MATCHING_CONFIG.PLY_CUTOFFS.middlegameEnd) return "middlegame";
  return "endgame";
}

export function meetsGameFloor(gameCount: number, minimumGames: number = MATCHING_CONFIG.BIGSHOT_MIN_GAMES): boolean {
  return gameCount >= minimumGames;
}

export function selectWinningCorpusGames<T extends { result: string }>(games: T[]): { games: T[]; availableWins: number; skipped: boolean } {
  const wins = MATCHING_CONFIG.BIGSHOT_INGEST_WINS_ONLY
    ? games.filter((game) => game.result === "win")
    : games;
  const skipped = wins.length < MATCHING_CONFIG.BIGSHOT_INGEST_MIN_WINS;
  if (skipped) return { games: [], availableWins: wins.length, skipped };
  if (wins.length <= MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS) return { games: wins, availableWins: wins.length, skipped: false };

  // Deterministically spread the capped subset through source order instead of
  // taking only the earliest records, which can encode a historical-era bias.
  const selected = Array.from({ length: MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS }, (_, index) =>
    wins[Math.floor(index * wins.length / MATCHING_CONFIG.BIGSHOT_INGEST_MAX_WINS)]!,
  );
  return { games: selected, availableWins: wins.length, skipped: false };
}

export function validateBigshotConfig(value: unknown): asserts value is BigshotConfig {
  if (!value || typeof value !== "object") throw new Error("target metadata must be an object");
  const target = value as Partial<BigshotConfig>;
  if (typeof target.name !== "string" || !target.name.trim()) throw new Error("name is required");
  if (!Array.isArray(target.aliases) || target.aliases.length === 0 || !target.aliases.every((alias) => typeof alias === "string")) {
    throw new Error("aliases must be a non-empty string array");
  }
  if (typeof target.sourceType !== "string" || !BIGSHOT_SOURCE_TYPES.includes(target.sourceType as BigshotSourceType)) {
    throw new Error("sourceType is unsupported");
  }
  if (typeof target.sourceRef !== "string" || !target.sourceRef.trim()) throw new Error("sourceRef is required");
}

/** Process each configured corpus independently; one invalid source must not cancel the rest. */
export async function processTargetsIndependently<T extends { name: string }, TResult>(
  targets: T[],
  processTarget: (target: T) => Promise<TResult>,
  onSkipped: (target: T, reason: string) => void,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (const target of targets) {
    try {
      results.push(await processTarget(target));
    } catch (error) {
      onSkipped(target, error instanceof Error ? error.message : "unknown source error");
    }
  }
  return results;
}

function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nameVariants(name: string): string[] {
  const normalized = normalizeName(name);
  const variants = new Set([normalized]);
  const commaIndex = name.indexOf(",");
  if (commaIndex >= 0) {
    const surname = name.slice(0, commaIndex).trim();
    const givenNames = name.slice(commaIndex + 1).trim();
    variants.add(normalizeName(`${givenNames} ${surname}`));
  }
  if (normalized) variants.add(normalized.split(" ").sort().join(" "));
  return [...variants].filter(Boolean);
}

function headerMatchesAliases(headerName: string, aliases: Set<string>): boolean {
  const variants = nameVariants(headerName);
  if (variants.some((variant) => aliases.has(variant))) return true;
  const comma = headerName.indexOf(",");
  const surname = normalizeName(comma >= 0 ? headerName.slice(0, comma) : headerName.split(/\s+/).at(-1) ?? "");
  if (!surname) return false;
  for (const alias of aliases) {
    const aliasComma = alias.indexOf(",");
    const aliasSurname = normalizeName(aliasComma >= 0 ? alias.slice(0, aliasComma) : alias.split(/\s+/).at(-1) ?? "");
    if (surname === aliasSurname) return true;
  }
  return false;
}

function splitPgn(pgn: string): string[] {
  return pgn.split(/(?=^\[Event\s)/m).map((block) => block.trim()).filter(Boolean);
}

function parseResult(headers: ReturnType<Chess["getHeaders"]>, color: "white" | "black"): ParsedGame["result"] {
  const result = headers.Result;
  if (result === "1/2-1/2") return "draw";
  if (result === "1-0") return color === "white" ? "win" : "loss";
  if (result === "0-1") return color === "black" ? "win" : "loss";
  return "draw";
}

export function parseTargetGames(
  source: SourceGame,
  target: BigshotConfig,
  firstId: number,
): Array<{ parsed: ParsedGame; pgn: string }> {
  const output: Array<{ parsed: ParsedGame; pgn: string }> = [];
  const aliases = new Set([target.name, ...target.aliases, ...(target.lichessUsername ? [target.lichessUsername] : [])].flatMap(nameVariants));
  for (const [index, pgnText] of splitPgn(source.pgn).entries()) {
    const chess = new Chess();
    try { chess.loadPgn(pgnText, { strict: false }); } catch { continue; }
    const headers = chess.getHeaders();
    const whiteName = headers.White ?? "White";
    const blackName = headers.Black ?? "Black";
    const isWhite = headerMatchesAliases(whiteName, aliases);
    const isBlack = headerMatchesAliases(blackName, aliases);
    if (!isWhite && !isBlack) continue;
    const playerColor: "white" | "black" = isWhite ? "white" : "black";
    const moves = chess.history();
    if (moves.length === 0) continue;

    // Persist a clean mainline: source comments, variations, NAGs, and annotations are omitted.
    const clean = new Chess();
    clean.setHeader("Event", headers.Event ?? "Historical game");
    clean.setHeader("White", whiteName);
    clean.setHeader("Black", blackName);
    clean.setHeader("Result", headers.Result ?? "*");
    for (const move of moves) clean.move(move);

    output.push({
      pgn: clean.pgn(),
      parsed: {
        id: `${target.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${firstId + index}`,
        playerColor,
        opponentUsername: playerColor === "white" ? blackName : whiteName,
        opponentRating: null,
        playerRating: null,
        moves,
        clocks: null,
        openingName: headers.Opening ?? null,
        openingEco: headers.ECO ?? null,
        result: parseResult(headers, playerColor),
        rated: false,
        speed: "classical",
        createdAt: null,
      },
    });
  }
  return output;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function sampleStats(vectors: StyleVector[]): CorpusStats {
  const means = {} as StyleVector;
  const stdDev = {} as StyleVector;
  for (const dimension of VECTOR_DIMENSIONS) {
    means[dimension] = mean(vectors.map((vector) => vector[dimension]));
    stdDev[dimension] = Math.sqrt(mean(vectors.map((vector) => (vector[dimension] - means[dimension]) ** 2)));
  }
  return { mean: means, stdDev };
}

export function buildCorpusPlan(
  prepared: PreparedBigshot[],
  minimumGames: number = MATCHING_CONFIG.BIGSHOT_MIN_GAMES,
): { eligible: EligibleBigshot[]; rejected: PreparedBigshot[]; stats: Record<MatchPhase, CorpusStats> | null } {
  const evaluated = prepared.map((item) => ({
    ...item,
    byPhase: Object.fromEntries(PHASES.map((phase) => [phase, item.games.filter((game) => game.vectors[phase] !== null)])) as Record<MatchPhase, AnalyzedGame[]>,
  }));
  const eligible = evaluated.filter((item) => PHASES.every((phase) => meetsGameFloor(item.byPhase[phase].length, minimumGames)));
  const rejected = evaluated.filter((item) => !eligible.includes(item));
  if (eligible.length === 0) return { eligible, rejected, stats: null };
  const stats = Object.fromEntries(PHASES.map((phase) => [
    phase,
    sampleStats(eligible.flatMap((item) => item.byPhase[phase].map((game) => game.vectors[phase]!))),
  ])) as Record<MatchPhase, CorpusStats>;
  return { eligible, rejected, stats };
}

export async function persistCorpus(tx: Prisma.TransactionClient, eligible: EligibleBigshot[], stats: Record<MatchPhase, CorpusStats>): Promise<void> {
  for (const phase of PHASES) {
    const sampleSize = eligible.reduce((sum, item) => sum + item.byPhase[phase].length, 0);
    await tx.bigshotVectorCalibration.upsert({
      where: { phase },
      create: { phase, means: stats[phase].mean, stdDevs: stats[phase].stdDev, sampleSize },
      update: { means: stats[phase].mean, stdDevs: stats[phase].stdDev, sampleSize },
    });
  }
  for (const item of eligible) {
    const bigshot = await tx.bigshot.upsert({
      where: { name: item.config.name },
      create: { name: item.config.name, gameCount: item.games.length },
      update: { gameCount: item.games.length },
    });
    await tx.bigshotPhaseProfile.deleteMany({ where: { bigshotId: bigshot.id } });
    await tx.bigshotSampleGame.deleteMany({ where: { bigshotId: bigshot.id } });
    for (const phase of PHASES) {
      const phaseGames = item.byPhase[phase];
      const rawProfile = {} as StyleVector;
      for (const dimension of VECTOR_DIMENSIONS) rawProfile[dimension] = mean(phaseGames.map((game) => game.vectors[phase]![dimension]));
      const normalizedProfile = normalizeStyleVector(rawProfile, {
        means: stats[phase].mean,
        stdDevs: stats[phase].stdDev,
        sampleSize: phaseGames.length,
      });
      await tx.bigshotPhaseProfile.create({
        data: { bigshotId: bigshot.id, phase, vector: normalizedProfile, sampleSize: phaseGames.length },
      });
      const samples = phaseGames.slice(0, 5);
      if (samples.length < 2) throw new Error(`${item.config.name}/${phase} lacks two sample games`);
      await tx.bigshotSampleGame.createMany({
        data: samples.map((game) => ({
          bigshotId: bigshot.id,
          phase,
          pgn: game.pgn,
          sourceRef: game.sourceRef,
          sourceType: game.sourceType,
          attribution: game.attribution,
          featureDetails: game.details[phase] as Prisma.InputJsonValue,
        })),
      });
    }
  }
}
