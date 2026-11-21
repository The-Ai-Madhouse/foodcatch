import type { PriceSource } from "@/lib/sources";

/**
 * A price (or an item name) that links to where it comes from, so the user can always check it
 * (docs/ui.md §22): a click/tap opens the source in a new tab, hover or keyboard focus shows a
 * bubble saying what the source is. Without a public page the bubble alone explains the source.
 * Server-renderable (no hooks); the text keeps the surrounding style, with a dotted underline as
 * the only hint.
 */
export function SourcedPrice({
  source,
  children,
  className = "",
}: {
  source: PriceSource | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  if (!source) return <span className={className}>{children}</span>;
  const bubble = (
    <span
      aria-hidden="true"
      className="pointer-events-none invisible absolute bottom-full left-0 z-40 mb-1 w-max max-w-64 rounded-md bg-ink px-2 py-1 text-left text-micro font-normal tracking-normal whitespace-normal text-page normal-case opacity-0 shadow-md transition-opacity group-hover/src:visible group-hover/src:opacity-100 group-focus-visible/src:visible group-focus-visible/src:opacity-100"
      style={{ fontStretch: "100%" }}
    >
      {source.label}
      {source.href ? " ↗" : ""}
    </span>
  );
  const look = `group/src relative cursor-pointer text-inherit underline decoration-current/35 decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-solid ${className}`;
  if (!source.href) {
    return (
      <span tabIndex={0} className={look}>
        {children}
        <span className="sr-only"> (kilde: {source.label})</span>
        {bubble}
      </span>
    );
  }
  return (
    <a href={source.href} target="_blank" rel="noopener noreferrer" className={look}>
      {children}
      <span className="sr-only"> – kilde: {source.label} (åbner i nyt vindue)</span>
      {bubble}
    </a>
  );
}
