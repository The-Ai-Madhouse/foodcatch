/**
 * Inline SVG icons (20 px, `currentColor`, hidden from assistive technology: every icon has a
 * text label next to it). No icon font, no emoji.
 */

type IconProps = { className?: string; size?: number };

function Svg({ className = "", size = 20, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </Svg>
  );
}

/** A clock with a leaf: food that must go soon. */
export function ClockLeafIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.6" />
      <path d="M12 8v4.5l3 1.5" />
      <path d="M15 3c3 0 6 1 6 1s0 4-3 5.5c-2 1-4 .5-4 .5s-.5-2 .5-4C15.4 4.6 15 3 15 3Z" />
    </Svg>
  );
}

/** A cooking pot: meal ideas. */
export function PotIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10h16v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-5Z" />
      <path d="M2 10h20" />
      <path d="M9 6c0-1 1-1.5 1-2.5M14 6c0-1 1-1.5 1-2.5" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function MapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </Svg>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Svg size={14} {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function RouteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16" />
    </Svg>
  );
}

export function CrosshairIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1.5" />
    </Svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg size={16} {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}
