interface Opening { name: string; eco: string; count: number }

const MIN_GAMES_FOR_FINGERPRINT = 30;

export default function OpeningFingerprint({ openings, games }: { openings: Opening[]; games: number }) {
  const branches = openings.filter((opening) => opening.count > 0).slice(0, 8);
  if (games < MIN_GAMES_FOR_FINGERPRINT || branches.length < 3) return null;
  const max = Math.max(...branches.map((opening) => opening.count));
  const points = branches.map((opening, index) => {
    const angle = (Math.PI * 2 * index) / branches.length - Math.PI / 2;
    const radius = 38 + 62 * (opening.count / max);
    return { ...opening, x: 160 + Math.cos(angle) * radius, y: 122 + Math.sin(angle) * radius, angle };
  });
  return <div className="mt-5 rounded-lg border border-white/10 bg-black/25 p-3">
    <p className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">Opening fingerprint · {games} game archive</p>
    <svg viewBox="0 0 320 244" role="img" aria-label="Radial view of your most frequently played openings" className="mx-auto mt-2 w-full max-w-[420px]">
      {[35, 65, 95].map((radius) => <circle key={radius} cx="160" cy="122" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 4" />)}
      {points.map((point) => <g key={`${point.eco}-${point.name}`}>
        <line x1="160" y1="122" x2={point.x} y2={point.y} stroke="rgba(52,211,153,0.35)" strokeWidth={1 + 2 * point.count / max} />
        <circle cx={point.x} cy={point.y} r={3 + 5 * point.count / max} fill="#6ee7b7" fillOpacity="0.8" />
      </g>)}
      <circle cx="160" cy="122" r="17" fill="#10231c" stroke="#34d399" strokeOpacity="0.7" />
      <text x="160" y="126" textAnchor="middle" fill="#d1fae5" fontSize="9" fontFamily="monospace">YOU</text>
      {points.map((point) => {
        const labelX = 160 + Math.cos(point.angle) * 116;
        const labelY = 122 + Math.sin(point.angle) * 116;
        return <text key={`label-${point.eco}-${point.name}`} x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fill="#a3a3a3" fontSize="8" fontFamily="monospace">{point.eco || point.name.slice(0, 8)}</text>;
      })}
    </svg>
    <p className="text-center text-[10px] text-neutral-600">Line weight and node size reflect recorded game count.</p>
  </div>;
}
