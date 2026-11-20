"use client";

/** Shown when a page fails to load, typically because the database cannot be reached. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;
  return (
    <>
      <h1 className="text-display shelf text-ink">Noget gik galt – prøv igen.</h1>
      <p className="mt-1 max-w-prose text-meta text-ink-2">
        Siden kunne ikke hentes. Oftest skyldes det, at databasen ikke kan nås – tjek at den kører,
        og at WEB_DATABASE_URL er sat.
      </p>
      {digest ? <p className="mt-1 text-meta text-ink-3">Fejlkode: {digest}</p> : null}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 h-11 rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90"
      >
        Prøv igen
      </button>
    </>
  );
}
