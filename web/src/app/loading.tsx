/** Shown while a page without its own loading state loads (the dishes take a moment). */
export default function Loading() {
  return (
    <div aria-busy="true" className="lg:max-w-[720px]">
      <div className="h-8 w-44 rounded bg-surface-2 motion-safe:animate-pulse" />
      <p className="sr-only" role="status">
        Henter…
      </p>
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-4">
            <div className="h-5 w-2/3 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="mt-3 h-6 w-1/3 rounded bg-surface-2 motion-safe:animate-pulse" />
            <div className="mt-3 h-4 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
