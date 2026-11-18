import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { NavLink } from "@/components/NavLink";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FoodCatch", template: "%s · FoodCatch" },
  description:
    "Find sunde basisvarer, der er dokumenteret billige nær dig: Netto-tilbud sammenlignet med andre butikker, madspild og prishistorik.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da">
      <body className="min-h-dvh bg-page text-ink antialiased">
        <a
          href="#indhold"
          className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10"
        >
          Spring til indhold
        </a>
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold text-ink no-underline"
            >
              <span
                aria-hidden="true"
                className="inline-block size-6 rounded-md bg-brand text-center text-sm leading-6 text-page"
              >
                F
              </span>
              FoodCatch
            </Link>
            <nav aria-label="Hovedmenu">
              <ul className="flex flex-wrap gap-1">
                <li>
                  <NavLink href="/">Ugens bedste køb</NavLink>
                </li>
                <li>
                  <NavLink href="/madspild">Madspild</NavLink>
                </li>
                <li>
                  <NavLink href="/status">Status</NavLink>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="indhold" className="mx-auto max-w-5xl px-4 py-8">
          {children}
        </main>
        <footer className="border-t border-line">
          <div className="mx-auto max-w-5xl space-y-1 px-4 py-6 text-sm text-ink-3">
            <p>
              Priser fra Salling Group, Tjek (eTilbudsavis), REMA 1000 og Open Food Facts. Data kan
              være forsinkede eller forkerte – tjek altid prisen i butikken.
            </p>
            <p>
              FoodCatch er open source (MIT):{" "}
              <a href="https://github.com/toke-dk/foodcatch">github.com/toke-dk/foodcatch</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
