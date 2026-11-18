import Link from "next/link";
import { formatRelative } from "@/lib/format";
import { HEALTH_META, assessPipeline, overallTone } from "@/lib/status";
import { getPipelineStatus } from "@/server/queries";

/**
 * One warn line on every page when the data is stale (same rule as /status: the overall tone is
 * bad). Renders nothing when the status cannot be read; the page itself reports such errors.
 */
export async function StaleBanner() {
  let runs;
  try {
    runs = await getPipelineStatus();
  } catch {
    return null;
  }
  const now = new Date();
  const jobs = assessPipeline(runs, now);
  if (overallTone(jobs) !== "bad") return null;
  const lastTimes = jobs
    .filter((j) => HEALTH_META[j.health].tone === "bad" && j.run)
    .map((j) => Date.parse(j.run?.finishedAt ?? j.run?.startedAt ?? ""))
    .filter(Number.isFinite);
  const oldest = lastTimes.length ? new Date(Math.min(...lastTimes)) : null;
  return (
    <div className="border-b border-warn-line bg-warn-bg text-warn-fg">
      <p className="mx-auto max-w-[1200px] px-4 py-2 text-meta lg:px-6">
        Priserne er måske forældede
        {oldest ? ` – data blev sidst hentet ${formatRelative(oldest, now)}` : ""}.{" "}
        <Link href="/status" className="font-semibold text-warn-fg underline">
          Se status
        </Link>
      </p>
    </div>
  );
}
