import { chainName, chainStyle } from "@/lib/chains";

/**
 * A chain's colour with its monogram (docs/ui.md §4.3), so colour is never the only cue. The
 * chain name is announced unless `labelled` says the name is already next to it.
 */
export function ChainDot({
  chainId,
  size = "sm",
  labelled = true,
}: {
  chainId: string;
  size?: "xs" | "sm" | "md";
  /** The chain name is visible next to the dot (the dot is then hidden from screen readers). */
  labelled?: boolean;
}) {
  const style = chainStyle(chainId);
  const dims =
    size === "xs"
      ? "size-3 text-[0px]"
      : size === "sm"
        ? "size-5 text-[9px]"
        : "size-8 text-[11px]";
  return (
    <span
      aria-hidden={labelled ? true : undefined}
      role={labelled ? undefined : "img"}
      aria-label={labelled ? undefined : chainName(chainId)}
      className={`inline-flex shrink-0 items-center justify-center rounded-full leading-none font-bold tracking-tight ${dims}`}
      style={{ background: style.fill, color: style.text }}
    >
      {size === "xs" ? null : style.monogram}
    </span>
  );
}
