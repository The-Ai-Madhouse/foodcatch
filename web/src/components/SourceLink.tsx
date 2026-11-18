import type { SourceLink as SourceLinkData } from "@/lib/sources";
import { ExternalIcon } from "./Icons";

/** An external link that opens in a new tab with an icon and a hidden "(åbner i nyt vindue)". */
export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 ${className}`}
    >
      {children}
      <ExternalIcon />
      <span className="sr-only"> (åbner i nyt vindue)</span>
    </a>
  );
}

/**
 * Where a price comes from (docs/ui.md §5.4): a link, or plain text for an expired offer or a
 * clearance without a product page. Nothing when there is no verified source.
 */
export function SourceLink({
  link,
  className = "",
}: {
  link: SourceLinkData | null;
  className?: string;
}) {
  if (!link) return null;
  if (!link.href) return <span className={`text-meta text-ink-3 ${className}`}>{link.label}</span>;
  return (
    <ExternalLink href={link.href} className={`text-meta ${className}`}>
      {link.label}
    </ExternalLink>
  );
}
