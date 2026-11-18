import type { Metadata } from "next";
import Link from "next/link";
import { DealCard } from "@/components/DealCard";
import { LocationForm } from "@/components/LocationForm";
import { NearbyChains } from "@/components/NearbyChains";
import { Notice } from "@/components/Notice";
import { PageHeader } from "@/components/PageHeader";
import {
  STATUS_META,
  countByStatus,
  evaluateDeals,
  filterDeals,
  groupDeals,
  parseDealFilter,
  type DealStatus,
} from "@/lib/deals";
import { getUserLocation } from "@/server/location";
import { getCurrentNettoDeals, getNearbyChains } from "@/server/queries";

export const metadata: Metadata = { title: "Ugens bedste køb nær dig" };

const SUMMARY_ORDER: DealStatus[] = [
  "good_deal",
  "undecided",
  "cheaper_elsewhere",
  "no_reference",
  "not_exact",
  "ambiguous_offer",
  "no_price",
  "pending",
];

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const filter = parseDealFilter((await searchParams).vis);
  const location = await getUserLocation();
  const [chains, rows] = await Promise.all([getNearbyChains(location), getCurrentNettoDeals()]);
  const nearby = new Set(chains.map((c) => c.chainId));
  const deals = evaluateDeals(rows, nearby);
  const counts = countByStatus(deals);
  const shown = filterDeals(deals, filter);
  const groups = groupDeals(shown);

  return (
    <>
      <PageHeader
        title="Ugens bedste køb nær dig"
        lead="Sunde basisvarer på tilbud i Netto, sammenlignet med præcis samme vare i butikkerne omkring dig, normalpriser og Nettos egne tidligere tilbud."
      />

      <section aria-label="Placering" className="space-y-4">
        <LocationForm
          label={location.label}
          radiusKm={location.radiusKm}
          isDefault={location.isDefault}
        />
        <NearbyChains chains={chains} radiusKm={location.radiusKm} />
        {chains.length > 0 && !nearby.has("netto") ? (
          <Notice tone="warn" title="Ingen Netto i nærheden">
            Der er ingen Netto inden for {location.radiusKm} km, så tilbuddene nedenfor kræver en
            længere tur.
          </Notice>
        ) : null}
      </section>

      <section aria-labelledby="tilbud-overskrift" className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="tilbud-overskrift" className="text-xl font-bold text-ink">
            Netto-tilbud på sunde basisvarer
          </h2>
          <nav aria-label="Filter" className="flex rounded-lg border border-line bg-surface p-1">
            <FilterLink active={filter === "gode"} href="/">
              Kun gode køb ({counts.good_deal})
            </FilterLink>
            <FilterLink active={filter === "alle"} href="/?vis=alle">
              Alle ({deals.length})
            </FilterLink>
          </nav>
        </div>

        {deals.length > 0 ? (
          <ul
            className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2"
            aria-label="Fordeling"
          >
            {SUMMARY_ORDER.filter((s) => counts[s] > 0).map((s) => (
              <li key={s}>
                <span className="font-semibold text-ink tabular">{counts[s]}</span>{" "}
                {STATUS_META[s].label.toLowerCase()}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6 space-y-10">
          {deals.length === 0 ? (
            <Notice title="Ingen aktuelle tilbud">
              Der er ingen aktuelle Netto-tilbud på sunde basisvarer i databasen. Se{" "}
              <Link href="/status">status</Link> for, hvornår data sidst blev hentet.
            </Notice>
          ) : groups.length === 0 ? (
            <Notice title="Ingen dokumenterede gode køb lige nu">
              Ingen af ugens {deals.length} tilbud er dokumenteret billigere end samme vare i
              nærheden. <Link href="/?vis=alle">Se alle tilbud</Link>.
            </Notice>
          ) : (
            groups.map((group) => (
              <section key={group.groupName} aria-labelledby={`gruppe-${group.groupName}`}>
                <h2 id={`gruppe-${group.groupName}`} className="text-lg font-bold text-ink">
                  {group.groupName}
                </h2>
                <div className="mt-3 space-y-6">
                  {group.types.map((type) => (
                    <section key={type.typeId} aria-label={type.typeLabel}>
                      <h3 className="mb-2 text-sm font-semibold tracking-wide text-ink-3 uppercase">
                        {type.typeLabel}
                      </h3>
                      <ul className="grid gap-3 md:grid-cols-2">
                        {type.deals.map((deal) => (
                          <li key={`${deal.listingId}-${deal.variantIndex}`}>
                            <DealCard deal={deal} nearbyChains={nearby} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </section>

      <section
        id="saadan-vurderer-vi"
        aria-labelledby="regel-overskrift"
        className="mt-12 rounded-xl border border-line bg-surface p-5 text-sm text-ink-2"
      >
        <h2 id="regel-overskrift" className="text-lg font-bold text-ink">
          Sådan vurderer vi et tilbud
        </h2>
        <p className="mt-2">
          Vi siger kun <strong className="text-ink">Godt køb</strong>, når det er dokumenteret.
          Reglen er bevidst forsigtig:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Vi sammenligner kun med <strong className="text-ink">præcis samme vare</strong>: samme
            type, samme fedtprocent, økologi, laktosefri og forarbejdning. Mangler en af
            egenskaberne i tilbuddet, sammenligner vi ikke (<em>Ukendt egenskab</em>).
          </li>
          <li>
            Netto vurderes ud fra sin <strong className="text-ink">højeste</strong> kilopris (den
            dyreste pakning i tilbuddet), sammenligningerne ud fra deres{" "}
            <strong className="text-ink">laveste</strong>.
          </li>
          <li>
            Tilbud og normalpriser fra andre kæder tæller kun, hvis kæden har en butik inden for din
            radius. Nettos egne tidligere tilbud og EAN-referencepriser tæller altid.
          </li>
          <li>
            Dækker et tilbud flere forskellige varer til samme pris, gælder kiloprisen ikke
            nødvendigvis den enkelte vare (<em>Flere varer i tilbuddet</em>).
          </li>
          <li>
            <em>Uafklaret</em> betyder, at Nettos pris afhænger af pakningen og overlapper den
            billigste sammenligning. <em>Billigere andetsteds</em> betyder, at selv Nettos bedste
            kilopris er højere.
          </li>
        </ul>
      </section>
    </>
  );
}

function FilterLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: "/" | "/?vis=alle";
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm font-medium no-underline ${
        active ? "bg-brand text-page" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}
