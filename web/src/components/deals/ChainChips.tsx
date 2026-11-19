import type { Route } from "next";
import Link from "next/link";
import { ChainDot } from "@/components/ChainDot";
import { chainName } from "@/lib/chains";
import { dealsHref, toggleChain, type DealFilter } from "@/lib/deals";

const CHIP =
  "relative flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-meta font-medium whitespace-nowrap no-underline border-line bg-surface text-ink hover:bg-surface-2 aria-[current=true]:border-ink aria-[current=true]:bg-ink aria-[current=true]:text-page";

/**
 * Chain filter of the deals page (`?kaede=lidl,netto`): one chip per chain that has offers and a
 * store within the radius. Chips are links (shareable, no client code); each toggles its chain,
 * "Alle kæder" clears the filter. Selected chips carry `aria-current` and a hidden "valgt".
 */
export function ChainChips({
  chains,
  selected,
  filter,
}: {
  /** Chains with offers nearby, with the number of offers shown for each. */
  chains: readonly { chainId: string; count: number }[];
  selected: readonly string[];
  filter: DealFilter;
}) {
  return (
    <nav aria-label="Kæder">
      <ul className="-mx-4 flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
        <li>
          <Link
            href={dealsHref(filter, null) as Route}
            scroll={false}
            aria-current={selected.length === 0 ? true : undefined}
            className={CHIP}
          >
            Alle kæder
          </Link>
        </li>
        {chains.map(({ chainId, count }) => {
          const active = selected.includes(chainId);
          return (
            <li key={chainId}>
              <Link
                href={dealsHref(filter, toggleChain(selected, chainId)) as Route}
                scroll={false}
                aria-current={active ? true : undefined}
                className={`${CHIP} pl-1.5`}
              >
                <ChainDot chainId={chainId} />
                {chainName(chainId)}
                <span className="tabular opacity-70">{count}</span>
                {active ? <span className="sr-only"> (valgt)</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
