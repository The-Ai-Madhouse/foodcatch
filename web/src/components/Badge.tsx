import {
  STATUS_META,
  memberPriceLabel,
  verdictBadgeLabel,
  type DealStatus,
  type Tone,
} from "@/lib/deals";

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  good: "border-good-line bg-good-bg text-good-fg",
  bad: "border-bad-line bg-bad-bg text-bad-fg",
  warn: "border-warn-line bg-warn-bg text-warn-fg",
  neutral: "border-neutral-line bg-neutral-bg text-neutral-fg",
};

/** A glyph per tone, so a badge never relies on colour alone. */
const TONE_ICONS: Readonly<Record<Tone, string>> = {
  good: "✓",
  bad: "✕",
  warn: "!",
  neutral: "–",
};

/** Tailwind classes for a tone (border, background, text). */
export function toneClasses(tone: Tone): string {
  return TONE_CLASSES[tone];
}

/** A small pill with the tone's glyph (or `icon`; `null` for none). */
export function Badge({
  tone,
  children,
  className = "",
  icon,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  icon?: string | null;
  title?: string;
}) {
  const glyph = icon === undefined ? TONE_ICONS[tone] : icon;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      {children}
    </span>
  );
}

/** The verdict of a deal (docs/ui.md §5.2); a marked member price reads "Godt køb med Netto+". */
export function VerdictBadge({
  status,
  memberOnly = false,
  chainId,
  className = "",
}: {
  status: DealStatus;
  memberOnly?: boolean;
  /** The offer's chain (names the membership of a member price). */
  chainId: string;
  className?: string;
}) {
  return (
    <Badge tone={STATUS_META[status].tone} className={className}>
      {verdictBadgeLabel(status, memberOnly, chainId)}
    </Badge>
  );
}

/** "★ Kræver Netto+": the price needs a membership of the chain's customer club. */
export function MemberBadge({ chainId }: { chainId: string }) {
  return (
    <Badge tone="warn" icon="★" title="Prisen gælder kun for medlemmer af kædens kundeklub">
      {memberPriceLabel(chainId)}
    </Badge>
  );
}

/** "★ Medlemspris" on a reference price. */
export function MemberPriceTag() {
  return (
    <Badge tone="warn" icon="★" title="Prisen gælder kun for medlemmer af kædens kundeklub">
      Medlemspris
    </Badge>
  );
}

/** "−80 %" in the good tone, with a visually hidden "Rabat". */
export function DiscountPill({ percent }: { percent: number }) {
  return (
    <Badge tone="good" icon={null} className="tabular">
      <span className="sr-only">Rabat </span>−{percent}&nbsp;%
    </Badge>
  );
}
