/** Shown while `/tilbud` loads: the title, the filter and three card-shaped placeholders. */
export default function Loading() {
  return (
    <div aria-busy="true" className="lg:max-w-[640px]">
      <h1 className="text-display shelf text-ink">Tilbud</h1>
      <p className="sr-only" role="status">
        Henter tilbud…
      </p>
      <div className="mt-3 h-11 w-56 rounded-[10px] border border-line bg-surface" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-4">
            <div className="h-5 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="mt-3 h-6 w-1/2 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="mt-3 h-4 w-2/3 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="mt-2 h-4 w-1/3 rounded bg-surface-2 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
