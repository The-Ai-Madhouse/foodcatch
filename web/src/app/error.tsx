"use client";

import { PageHeader } from "@/components/PageHeader";

/** Shown when a page fails to load, typically because the database cannot be reached. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;
  return (
    <>
      <PageHeader
        title="Noget gik galt"
        lead="Siden kunne ikke hentes. Oftest skyldes det, at databasen ikke kan nås – tjek at den kører, og at WEB_DATABASE_URL er sat."
      />
      {digest ? <p className="text-sm text-ink-3">Fejlkode: {digest}</p> : null}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded-md bg-brand px-4 py-2 font-semibold text-page hover:opacity-90"
      >
        Prøv igen
      </button>
    </>
  );
}
