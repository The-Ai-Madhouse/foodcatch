import type { Tone } from "@/lib/deals";
import { toneClasses } from "./Badge";

/** A highlighted message box. */
export function Notice({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-body ${toneClasses(tone)}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? "mt-1" : undefined}>{children}</div>
    </div>
  );
}
