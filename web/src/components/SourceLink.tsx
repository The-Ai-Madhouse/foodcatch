import type { SourceLink as SourceLinkData } from "@/lib/sources";
import { ExternalIcon } from "./Icons";

/** An external link that opens in a new tab with an icon and a hidden "(åbner i nyt vindue)". */
export function ExternalLink({
  href,
  children,
  className = "",
  iconSize,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  iconSize?: number;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 ${className}`}
    >
      {children}
      <ExternalIcon size={iconSize} />
      <span className="sr-only"> (åbner i nyt vindue)</span>
    </a>
  );
}

/**
 * Where a price comes from (docs/ui.md §5.4): a link, or plain text for an expired offer or a
 * clearance without a product page. Nothing when there is no verified source. Deliberately
 * quiet (small, muted): it is there for the sceptical reader, not as a call to action.
 */
export function SourceLink({
  link,
  className = "",
}: {
  link: SourceLinkData | null;
  className?: string;
}) {
  if (!link) return null;
  if (!link.href) return <span className={`text-micro text-ink-3 ${className}`}>{link.label}</span>;
  return (
    <ExternalLink
      href={link.href}
      iconSize={14}
      className={`text-micro text-ink-3 decoration-ink-3/50 hover:text-ink-2 ${className}`}
    >
      {link.label}
    </ExternalLink>
  );
}
