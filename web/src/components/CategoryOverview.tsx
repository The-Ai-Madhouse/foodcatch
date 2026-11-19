import { ChevronIcon } from "@/components/Icons";

export interface CategoryLink {
  label: string;
  count: number;
  href: string;
  active?: boolean;
}

/**
 * A short overview of a list's categories (docs/ui.md §14): one pill per category with its
 * count, scrolling sideways on a phone. Links jump to the category or filter by it.
 */
export function CategoryOverview({
  label,
  links,
}: {
  /** Accessible name of the navigation ("Kategorier"). */
  label: string;
  links: readonly CategoryLink[];
}) {
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
      <ul className="flex w-max gap-2 pb-1">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              aria-current={link.active ? "true" : undefined}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-meta font-medium whitespace-nowrap text-ink no-underline hover:bg-surface-2 aria-[current=true]:border-brand aria-[current=true]:text-brand"
            >
              {link.label}
              <span className="text-ink-3 tabular">{link.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * A category of a list that can be folded away: a `<details>` that starts open, with the name
 * and count in its summary.
 */
export function CollapsibleCategory({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <details open id={id} className="group/category scroll-mt-28">
      <summary className="flex h-11 items-center gap-2 text-meta font-semibold text-ink-3">
        <span>{title}</span>
        <span className="font-normal tabular">({count})</span>
        <ChevronIcon className="ml-auto details-chevron" />
        <span className="sr-only group-open/category:hidden">Fold ud</span>
        <span className="sr-only hidden group-open/category:inline">Fold sammen</span>
      </summary>
      {children}
    </details>
  );
}
