"use client";

import { useState } from "react";

/**
 * A `<details>` that keeps its open state across server re-renders (a server action that
 * revalidates the page would otherwise reset it to `initialOpen`).
 */
export function Disclosure({
  initialOpen,
  className,
  children,
}: {
  initialOpen: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={className}>
      {children}
    </details>
  );
}
