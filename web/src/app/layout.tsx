import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MainNav } from "@/components/layout/MainNav";
import { StaleBanner } from "@/components/layout/StaleBanner";
import { LocationControl } from "@/components/location/LocationControl";
import { getUserLocation } from "@/server/location";
import localFont from "next/font/local";
import "./globals.css";

// Archivo, variable in weight and width (self-hosted, see app/fonts/README.md).
const archivo = localFont({
  src: "./fonts/archivo-latin.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

export const metadata: Metadata = {
  title: { default: "FoodCatch", template: "%s · FoodCatch" },
  description:
    "Find sunde basisvarer, der er dokumenteret billige nær dig: ugens tilbud fra alle kæder sammenlignet med andre butikker, madspild og prishistorik.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a19" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const location = await getUserLocation();
  return (
    <html lang="da" className={archivo.variable}>
      <body className="min-h-dvh bg-page pb-tabbar text-ink antialiased md:pb-0">
        <a
          href="#indhold"
          className="sr-only rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
        >
          Spring til indhold
        </a>
        <header className="sticky top-0 z-30 border-b border-line bg-surface">
          <div className="mx-auto flex h-12 max-w-[1200px] items-center justify-between gap-3 px-4 md:h-14 lg:px-6">
            <div className="flex min-w-0 items-center gap-6">
              <Link href="/" className="shrink-0 text-title shelf text-ink no-underline">
                FoodCatch
              </Link>
              <MainNav variant="header" />
            </div>
            <LocationControl location={location} />
          </div>
        </header>
        <Suspense fallback={null}>
          <StaleBanner />
        </Suspense>
        <main id="indhold" className="mx-auto max-w-[1200px] px-4 pt-4 pb-8 lg:px-6 lg:pt-6">
          {children}
        </main>
        <footer data-site-footer className="border-t border-line">
          <div className="mx-auto max-w-[1200px] px-4 py-6 text-meta text-ink-3 lg:px-6">
            <p>
              Priser fra Tjek (eTilbudsavis), REMA 1000, Salling Group og Open Food Facts. Tjek
              altid prisen i butikken.
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <Link href="/status">Datastatus</Link>
              <a href="https://github.com/toke-dk/foodcatch">Kildekode (MIT)</a>
            </p>
          </div>
        </footer>
        <MainNav variant="tabs" />
      </body>
    </html>
  );
}
