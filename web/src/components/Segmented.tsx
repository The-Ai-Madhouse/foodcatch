import type { Route } from "next";
import Link from "next/link";

/** A segmented control of links (shareable views such as `?vis=alle`); `aria-current` marks the active one. */
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: readonly { href: Route; label: string; active: boolean }[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="inline-flex rounded-[10px] border border-line bg-surface p-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              scroll={false}
              className="flex h-9 items-center rounded-[8px] px-3 text-meta font-medium text-ink-2 no-underline hover:text-ink aria-[current=page]:bg-brand aria-[current=page]:text-page"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
