"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClockLeafIcon, MapIcon, TagIcon } from "@/components/Icons";

const ITEMS: readonly { href: Route; label: string; Icon: typeof TagIcon }[] = [
  { href: "/", label: "Tilbud", Icon: TagIcon },
  { href: "/madspild", label: "Madspild", Icon: ClockLeafIcon },
  { href: "/kort", label: "Kort", Icon: MapIcon },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The main navigation: links in the desktop header, a bottom tab bar on phones. */
export function MainNav({ variant }: { variant: "header" | "tabs" }) {
  const pathname = usePathname();

  if (variant === "header") {
    return (
      <nav aria-label="Hovedmenu" className="hidden md:block">
        <ul className="flex gap-1">
          {ITEMS.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive(pathname, href) ? "page" : undefined}
                className="flex h-11 items-center rounded-[10px] px-3 font-medium text-ink-2 no-underline hover:bg-surface-2 hover:text-ink aria-[current=page]:text-brand aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-[18px]"
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Faner"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid h-14 grid-cols-3">
        {ITEMS.map(({ href, label, Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className="flex h-full flex-col items-center justify-center gap-0.5 text-micro font-medium text-ink-3 no-underline aria-[current=page]:text-brand"
            >
              <Icon />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
