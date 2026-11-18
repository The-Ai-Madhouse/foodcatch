import type { Tone } from "@/lib/deals";

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  good: "border-good-line bg-good-bg text-good-fg",
  bad: "border-bad-line bg-bad-bg text-bad-fg",
  warn: "border-warn-line bg-warn-bg text-warn-fg",
  neutral: "border-neutral-line bg-neutral-bg text-neutral-fg",
};

/** A glyph per tone, so a badge never relies on color alone. */
const TONE_ICONS: Readonly<Record<Tone, string>> = {
  good: "✓",
  bad: "✕",
  warn: "≈",
  neutral: "–",
};

/** Tailwind classes for a tone (border, background, text). */
export function toneClasses(tone: Tone): string {
  return TONE_CLASSES[tone];
}

/** A small status label with an icon (the tone's glyph unless `icon` is given). */
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
  icon?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      <span aria-hidden="true">{icon ?? TONE_ICONS[tone]}</span>
      {children}
    </span>
  );
}

/** The "Medlemspris" badge: the price needs a membership (Netto+, Coop-medlem). */
export function MemberPriceBadge({ label, className = "" }: { label: string; className?: string }) {
  return (
    <Badge
      tone="warn"
      icon="★"
      title="Prisen gælder kun for medlemmer af kædens kundeklub"
      className={className}
    >
      {label}
    </Badge>
  );
}
