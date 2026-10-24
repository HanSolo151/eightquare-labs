import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { isStyleVector, PHASES, type MatchPhase, type PhaseVectorCalibration, type StyleVector, type VectorCalibration } from "@/lib/matching/vectorSchema";
import WinsAnalysis, { type WinAnalysisGame } from "@/components/dashboard/WinsAnalysis";
import type { EvalPoint } from "@/types";

export const instant = false;
const PAGE_SIZE = 10;

function jsonNumberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value : null;
}

function readEvalPoints(value: unknown): EvalPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): EvalPoint[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const point = entry as Partial<EvalPoint>;
    const validNullable = (item: unknown) => item === null || typeof item === "number";
    if (!Number.isInteger(point.ply) || !validNullable(point.cpBefore) || !validNullable(point.cpAfter)
      || !validNullable(point.mateBefore) || !validNullable(point.mateAfter) || typeof point.depth !== "number"
      || !(point.bestMoveUci === null || typeof point.bestMoveUci === "string")) return [];
    return [point as EvalPoint];
  });
}

export default async function WinsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const [session, query] = await Promise.all([auth(), searchParams]);
  const userId = getSessionUserId(session);
  if (!userId) redirect("/login");
  const requestedPage = query.page && /^\d+$/.test(query.page) ? Math.max(1, Number(query.page)) : 1;
  const [totalWins, profileRows, calibrationRows] = await Promise.all([
    prisma.game.count({ where: { userId, result: "win" } }),
    prisma.bigshotPhaseProfile.findMany({
      include: { bigshot: { select: { name: true } } },
      orderBy: [{ bigshot: { name: "asc" } }, { phase: "asc" }],
    }),
    prisma.bigshotVectorCalibration.findMany(),
  ]);
  const pages = Math.max(1, Math.ceil(totalWins / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const gameRows = await prisma.game.findMany({
    where: { userId, result: "win" },
    orderBy: [{ lichessCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true, opponentUsername: true, opponentRating: true, playerRating: true, playerColor: true,
      moves: true, clocks: true, clockInitialSec: true, clockIncrementSec: true, openingName: true,
      openingEco: true, rated: true, speed: true, lichessCreatedAt: true,
      eval: { select: { points: true, engineVersion: true, evaluatedAt: true } },
      vanityEvaluationJob: { select: { status: true } },
    },
  });
  const games: WinAnalysisGame[] = gameRows.map((game) => ({
    id: game.id,
    opponentUsername: game.opponentUsername,
    opponentRating: game.opponentRating,
    playerRating: game.playerRating,
    playerColor: game.playerColor === "black" ? "black" : "white",
    moves: Array.isArray(game.moves) ? game.moves.filter((move): move is string => typeof move === "string") : [],
    clocks: jsonNumberArray(game.clocks),
    clockInitialSec: game.clockInitialSec,
    clockIncrementSec: game.clockIncrementSec,
    openingName: game.openingName,
    openingEco: game.openingEco,
    rated: game.rated,
    speed: game.speed,
    createdAt: game.lichessCreatedAt?.toISOString() ?? null,
    evaluation: game.eval ? {
      points: readEvalPoints(game.eval.points),
      engineVersion: game.eval.engineVersion,
      evaluatedAt: game.eval.evaluatedAt.toISOString(),
    } : null,
    evaluationStatus: game.vanityEvaluationJob?.status ?? null,
  }));

  const profiles = profileRows.flatMap((row) =>
    PHASES.includes(row.phase as MatchPhase) && isStyleVector(row.vector)
      ? [{ bigshotId: row.bigshotId, bigshotName: row.bigshot.name, phase: row.phase as MatchPhase, vector: row.vector as StyleVector }]
      : [],
  );
  const calibrationEntries = calibrationRows.flatMap((row) =>
    PHASES.includes(row.phase as MatchPhase) && isStyleVector(row.means) && isStyleVector(row.stdDevs)
      ? [[row.phase as MatchPhase, { means: row.means as StyleVector, stdDevs: row.stdDevs as StyleVector, sampleSize: row.sampleSize }] as const]
      : [],
  );
  const calibrationMap = new Map<MatchPhase, PhaseVectorCalibration>(calibrationEntries);
  const calibration = PHASES.every((phase) => calibrationMap.has(phase))
    ? Object.fromEntries(PHASES.map((phase) => [phase, calibrationMap.get(phase)!])) as VectorCalibration
    : null;
  const profileReady = profiles.length === 90 && calibration !== null;

  return <div className="space-y-7 pb-12">
    <header className="flex flex-col justify-between gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-end">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Your analysis / 03</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Wins</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-400">Choose a win to compare your opening, middlegame, and endgame style with the 30-player library. The comparison runs in your browser using the saved moves and evaluation.</p>
      </div>
      <span className="text-xs tabular-nums text-neutral-400">{totalWins.toLocaleString()} saved wins</span>
    </header>

    {!profileReady && <p role="status" className="rounded-lg border border-amber-200/20 bg-amber-200/[0.04] p-3 text-xs text-amber-100">The style library is not available right now.</p>}
    {totalWins === 0 ? <section className="rounded-xl border border-dashed border-white/15 bg-black/30 px-6 py-12 text-center">
      <p className="text-lg">No wins in your archive yet</p>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-neutral-500">Sync your Lichess games from the Signature screen. New wins will appear here as they are saved.</p>
      <Link href="/dashboard/signature" className="mt-5 inline-flex text-sm text-emerald-200 hover:text-white">Open Signature →</Link>
    </section> : <>
      <WinsAnalysis games={games} profiles={profiles} calibration={profileReady ? calibration : null} />
      {pages > 1 && <nav aria-label="Win pages" className="flex items-center justify-between border-t border-white/10 pt-4 text-sm">
        {page > 1 ? <Link href={`/dashboard/wins?page=${page - 1}`} className="text-neutral-300 hover:text-white">← Newer wins</Link> : <span className="text-neutral-700">← Newer wins</span>}
        <span className="text-xs tabular-nums text-neutral-500">Page {page} / {pages}</span>
        {page < pages ? <Link href={`/dashboard/wins?page=${page + 1}`} className="text-neutral-300 hover:text-white">Older wins →</Link> : <span className="text-neutral-700">Older wins →</span>}
      </nav>}
    </>}
  </div>;
}
