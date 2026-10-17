import { auth } from "@/lib/auth";
import { getSessionUserId } from "@/lib/auth/session";
import { getPatternsData } from "@/lib/patterns/getPatternsData";

const SEVERITY_ORDER = ["high", "medium", "low"] as const;
const SEVERITY_COLOR: Record<string, string> = {
  high: "bg-red-900/60",
  medium: "bg-yellow-900/50",
  low: "bg-neutral-800",
};

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

// Step 6: Screen 3, "Patterns", wired to real data. Calls getPatternsData()
// directly — same query GET /api/patterns uses, no self-fetch. The bias
// section stays an explicit "not built" placeholder when no BiasProfile
// row exists, per getPatternsData's own rule: never fabricate numbers for
// an engine that hasn't been written yet.
export default async function PatternsPage() {
  const session = await auth();
  const userId = getSessionUserId(session);

  if (!userId) {
    return (
      <section className="rounded border border-neutral-800 p-6">
        <p className="text-neutral-500">No signed-in session.</p>
      </section>
    );
  }

  const data = await getPatternsData(userId);

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded border border-neutral-800 p-6">
        <h2 className="text-sm text-neutral-400">Openings by blunder rate</h2>
        {data.openings.length === 0 ? (
          <p className="text-neutral-500">
            Not enough evaluated games per opening yet to rank anything (need at least 2 games
            in the same opening).
          </p>
        ) : (
          <ul className="space-y-2">
            {data.openings.map((opening) => (
              <li
                key={opening.name}
                className="flex items-center justify-between text-sm text-neutral-300"
              >
                <span>
                  {opening.name}
                  {opening.eco && <span className="text-neutral-500"> ({opening.eco})</span>}
                  <span className="text-neutral-500"> — {opening.gamesPlayed} games</span>
                </span>
                <span className="text-neutral-400">
                  {formatPct(opening.blunderRate)} games flagged ({opening.flaggedGameCount}/{opening.gamesPlayed}) · {opening.avgCpLoss} avg cp loss
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded border border-neutral-800 p-6">
        <h2 className="text-sm text-neutral-400">Flags by phase &amp; severity</h2>
        <table className="w-full text-sm text-neutral-300">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-normal">phase</th>
              {SEVERITY_ORDER.map((severity) => (
                <th key={severity} className="pb-2 font-normal capitalize">
                  {severity}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(Object.keys(data.heatmap) as (keyof typeof data.heatmap)[]).map((phase) => (
              <tr key={phase}>
                <td className="py-1 pr-4 capitalize text-neutral-400">{phase}</td>
                {SEVERITY_ORDER.map((severity) => {
                  const count = data.heatmap[phase][severity];
                  return (
                    <td key={severity} className="py-1 pr-4">
                      <span
                        className={`inline-block min-w-[2.5rem] rounded px-2 py-0.5 text-center ${
                          count > 0 ? SEVERITY_COLOR[severity] : ""
                        }`}
                      >
                        {count}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3 rounded border border-neutral-800 p-6">
        <h2 className="text-sm text-neutral-400">Weakness patterns</h2>
        {data.weaknessPatterns.length === 0 ? (
          <p className="text-neutral-500">No repeated patterns found yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.weaknessPatterns.map((pattern) => (
              <li key={pattern.id} className="text-sm text-neutral-300">
                {pattern.description}{" "}
                <span className="text-neutral-500">
                  — seen {pattern.occurrenceCount} time{pattern.occurrenceCount === 1 ? "" : "s"}
                  {pattern.tags.length > 0 && ` · ${pattern.tags.join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2 rounded border border-neutral-800 p-6">
        <h2 className="text-sm text-neutral-400">Spatial bias (rank / file / diagonal)</h2>
        {data.bias.built ? (
          <p className="text-sm text-neutral-300">
            Sample size {data.bias.sampleSize} · confidence {data.bias.confidence}
          </p>
        ) : (
          <p className="text-neutral-500">
            Not built yet — the spatial bias engine hasn&apos;t been written. This isn&apos;t
            hidden missing data; there&apos;s genuinely nothing computed here yet.
          </p>
        )}
      </section>

      <p className="text-xs text-neutral-600">
        {data.meta.gamesEvaluated} of {data.meta.gamesFetched} games evaluated · {data.meta.confidence}
        {" "}confidence
      </p>
    </div>
  );
}
