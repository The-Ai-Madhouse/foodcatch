"use client";

import { useState } from "react";
import { ChevronIcon } from "@/components/Icons";
import { STAPLES_FOLDED_COOKIE } from "@/lib/staple-catalogue";

const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/**
 * The fold of "Dine basisvarer": a `<details>` whose state is remembered in a cookie, so the
 * server renders it folded on the next visit without a flash. Works without JS (just not
 * remembered).
 */
export function StaplesFold({
  initialOpen,
  title,
  summary,
  children,
}: {
  initialOpen: boolean;
  title: React.ReactNode;
  /** Short status next to the title ("4 på tilbud"), also shown while folded. */
  summary: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        document.cookie = `${STAPLES_FOLDED_COOKIE}=${next ? "0" : "1"}; path=/; max-age=${COOKIE_MAX_AGE_S}; samesite=lax`;
      }}
      className="group/staples"
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 py-1">
        {title}
        {summary ? <span className="text-meta text-ink-2 tabular">{summary}</span> : null}
        <span className="ml-auto flex items-center gap-1 text-meta font-medium text-link">
          <span className="group-open/staples:hidden">Vis</span>
          <span className="hidden group-open/staples:inline">Fold sammen</span>
          <ChevronIcon className="details-chevron" />
        </span>
      </summary>
      {children}
    </details>
  );
}
