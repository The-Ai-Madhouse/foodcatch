import { formatDistance } from "@/lib/format";
import type { NearbyChain } from "@/server/queries";

/** The chains with a store within the user's radius, nearest first. */
export function NearbyChains({ chains, radiusKm }: { chains: NearbyChain[]; radiusKm: number }) {
  if (chains.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        Vi kender ingen butikker inden for {radiusKm} km. Prøv en større radius eller en anden
        adresse.
      </p>
    );
  }
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">Kæder i nærheden</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {chains.map((c) => (
          <li
            key={c.chainId}
            className="rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink"
          >
            {c.chainName}{" "}
            <span className="text-ink-3 tabular">
              <span className="sr-only">, nærmeste butik </span>
              {formatDistance(c.nearestKm)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
