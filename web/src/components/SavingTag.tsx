import { chainName } from "@/lib/chains";
import { formatDkk } from "@/lib/format";
import type { Saving } from "@/lib/savings";

/** Where the normal price comes from, in one sentence ("Normalpris 28,00 kr. i Netto."). */
export function savingBasisText(saving: Saving): string {
  if (saving.kind === "unknown") {
    return "Vi kender ikke normalprisen på præcis samme vare, så vi kan ikke sige, hvad du sparer.";
  }
  const where =
    saving.basis === "before"
      ? "før nedsættelsen"
      : saving.basis === "ean"
        ? "hos Salling (samme stregkode)"
        : saving.normalChainId
          ? `i ${chainName(saving.normalChainId)} (samme vare, nær dig)`
          : "";
  if (saving.kind === "depends") {
    return `Kun de største pakninger er billigere end normalprisen ${where}.`;
  }
  return `Normalpris ${formatDkk(saving.normalPrice)} ${where}.`;
}

/**
 * The saving against the normal price (docs/ui.md §21), the same everywhere: "Spar 8,62 kr.
 * −28 %", "Spar op til …", "Ingen besparelse" or "Normalpris ukendt". The basis is in the
 * tooltip and for screen readers.
 */
export function SavingTag({
  saving,
  size = "md",
  className = "",
}: {
  saving: Saving;
  size?: "sm" | "md";
  className?: string;
}) {
  const basis = savingBasisText(saving);
  const pad = size === "sm" ? "px-1.5 py-px text-micro" : "px-2 py-0.5 text-meta";
  if (saving.kind === "saving") {
    return (
      <span
        title={basis}
        className={`inline-flex items-center gap-1 rounded-md bg-good-fg font-semibold whitespace-nowrap text-page tabular ${pad} ${className}`}
      >
        Spar {formatDkk(saving.amount)}
        {saving.percent >= 1 ? (
          <span className="font-normal opacity-90">−{saving.percent}&nbsp;%</span>
        ) : null}
        <span className="sr-only">. {basis}</span>
      </span>
    );
  }
  if (saving.kind === "depends") {
    return (
      <span
        title={basis}
        className={`inline-flex items-center rounded-md border border-good-line bg-good-bg font-medium whitespace-nowrap text-good-fg tabular ${pad} ${className}`}
      >
        Spar op til {formatDkk(saving.maxAmount)}
        <span className="sr-only">. {basis}</span>
      </span>
    );
  }
  if (saving.kind === "none") {
    return (
      <span
        title={basis}
        className={`inline-flex items-center rounded-md border border-line-strong font-medium whitespace-nowrap text-ink-2 ${pad} ${className}`}
      >
        Ingen besparelse
        <span className="sr-only">. {basis}</span>
      </span>
    );
  }
  return (
    <span title={basis} className={`whitespace-nowrap text-ink-3 ${pad} px-0 ${className}`}>
      Normalpris ukendt
    </span>
  );
}
