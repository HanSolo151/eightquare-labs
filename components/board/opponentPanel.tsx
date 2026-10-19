import { useOpponentFeatures } from "../../lib/useOpponentFeatures";

interface OpponentPanelProps {
  opponentUsername: string;
  userId: string | null;
}

/**
 * Collapsible-by-usage opponent features block. Lazy-loads on mount of
 * THIS component — the parent (VerdictCard) is expected to only mount
 * this when the user expands a card, which is what makes it "on demand"
 * rather than fetched for every flagged move up front.
 *
 * Structure-only styling, no color/theme — consistent with Steps 5-6's
 * deferred-theming decision.
 */
export function OpponentPanel({ opponentUsername, userId }: OpponentPanelProps) {
  const { features, loading, error, load } = useOpponentFeatures(userId);

  // Fire the load on first render. Not wrapped in a useEffect with an
  // explicit mount guard because the parent already controls mount/unmount
  // (expand/collapse), so "mounted" IS the trigger.
  if (!features && !loading && !error) {
    load(opponentUsername);
  }

  if (loading) return <div>Loading opponent profile…</div>;
  if (error) return <div>Could not load opponent profile: {error}</div>;
  if (!features) return null;

  if (features.gamesAnalyzed === 0) {
    return <div>No recent rated rapid games found for {opponentUsername}.</div>;
  }

  return (
    <div style={{ border: "1px solid #ccc", padding: "0.5rem", marginTop: "0.5rem" }}>
      <strong>{features.username}</strong> — {features.gamesAnalyzed} games analyzed
      {features.avgRating !== null && <> (avg rating {Math.round(features.avgRating)})</>}
      <ul>
        <li>Queen-trade rate: {(features.queenTradeRate * 100).toFixed(0)}%</li>
        <li>Aggression index: {(features.aggressionIndex * 100).toFixed(0)}%</li>
      </ul>
      <div>Top openings:</div>
      <ul>
        {features.mostCommonOpenings.map((o) => (
          <li key={`${o.eco}:${o.name}`}>
            {o.name} ({o.eco}) — {o.count}
          </li>
        ))}
      </ul>
    </div>
  );
}
