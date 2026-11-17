export default function ClaimCard({ claim, stat, context }: { claim: string; stat: string | number; context?: string }) {
  return <article className="border-l border-amber-300/30 py-1 pl-4">
    <p className="font-mono text-2xl tabular-nums text-neutral-100">{stat}</p>
    <p className="mt-1 text-sm leading-6 text-neutral-200">{claim}</p>
    {context && <p className="mt-1 text-xs leading-5 text-neutral-500">{context}</p>}
  </article>;
}
