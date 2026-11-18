import type { Metadata } from "next";
import { Badge } from "@/components/Badge";
import { Notice } from "@/components/Notice";
import { PageHeader } from "@/components/PageHeader";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import {
  HEALTH_META,
  REVIEW_REASON_LABELS,
  assessPipeline,
  overallTone,
  summarizeStats,
  type JobAssessment,
} from "@/lib/status";
import { getPipelineStatus, getReviewQueueSummary } from "@/server/queries";

export const metadata: Metadata = { title: "Status" };

const OVERALL_TEXT = {
  good: { title: "Alt kører", body: "Alle datakilder er opdateret inden for deres tidsplan." },
  warn: {
    title: "Noget kræver opmærksomhed",
    body: "Mindst én kilde er forringet eller har aldrig kørt.",
  },
  bad: {
    title: "Data er forældede eller fejlede",
    body: "Mindst én kilde er fejlet, hænger eller er ikke opdateret til tiden. Priserne nedenfor kan være gamle.",
  },
  neutral: { title: "Ingen kørsler endnu", body: "Pipelinen har ikke registreret nogen kørsler." },
} as const;

export default async function StatusPage() {
  const [runs, review] = await Promise.all([getPipelineStatus(), getReviewQueueSummary()]);
  const now = new Date();
  const jobs = assessPipeline(runs, now);
  const tone = overallTone(jobs);
  const overall = OVERALL_TEXT[tone];
  const openTotal = review.reduce((sum, r) => sum + r.openCount, 0);

  return (
    <>
      <PageHeader
        title="Status"
        lead="Hvor friske er data? Seneste kørsel af hvert job i datapipelinen og køen af varer, der venter på manuel gennemgang."
      />
      <Notice tone={tone} title={overall.title}>
        {overall.body} Opdateret {formatDateTime(now)}.
      </Notice>

      <section aria-labelledby="jobs-overskrift" className="mt-8">
        <h2 id="jobs-overskrift" className="text-lg font-bold text-ink">
          Datakilder
        </h2>
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {jobs.map((job) => (
            <li key={job.job}>
              <JobCard job={job} now={now} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="review-overskrift" className="mt-10">
        <h2 id="review-overskrift" className="text-lg font-bold text-ink">
          Til manuel gennemgang
        </h2>
        {openTotal === 0 ? (
          <p className="mt-2 text-sm text-ink-2">Ingen åbne sager.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Åbne sager pr. årsag</caption>
              <thead className="text-xs text-ink-3">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Årsag
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Åbne
                  </th>
                </tr>
              </thead>
              <tbody>
                {review.map((r) => (
                  <tr key={r.reason} className="border-t border-line">
                    <td className="px-3 py-2">{REVIEW_REASON_LABELS[r.reason] ?? r.reason}</td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(r.openCount, 0)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line-strong font-semibold">
                  <td className="px-3 py-2">I alt</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(openTotal, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function JobCard({ job, now }: { job: JobAssessment; now: Date }) {
  const meta = HEALTH_META[job.health];
  const run = job.run;
  const stats = run ? summarizeStats(run.stats) : [];
  return (
    <article className="h-full rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">{job.label}</h3>
          <p className="font-mono text-xs text-ink-3">{job.job}</p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <dl className="mt-3 space-y-1 text-sm text-ink-2">
        {job.schedule ? (
          <div>
            <dt className="inline">Plan: </dt>
            <dd className="inline">{job.schedule}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline">Seneste kørsel: </dt>
          <dd className="inline">
            {run ? (
              <>
                {formatDateTime(run.finishedAt ?? run.startedAt)} (
                {formatRelative(run.finishedAt ?? run.startedAt, now)})
              </>
            ) : (
              "aldrig"
            )}
          </dd>
        </div>
        {run ? (
          <div>
            <dt className="inline">Resultat: </dt>
            <dd className="inline">{RUN_STATUS_LABELS[run.status] ?? run.status}</dd>
          </div>
        ) : null}
        {stats.length > 0 ? (
          <div>
            <dt className="inline">Tal: </dt>
            <dd className="inline tabular">
              {stats.map(([k, v]) => `${k} ${formatNumber(v, 0)}`).join(" · ")}
            </dd>
          </div>
        ) : null}
      </dl>
      {run?.error ? (
        <pre className="mt-3 overflow-x-auto rounded-md bg-bad-bg p-2 text-xs whitespace-pre-wrap text-bad-fg">
          {run.error}
        </pre>
      ) : null}
    </article>
  );
}

const RUN_STATUS_LABELS: Readonly<Record<string, string>> = {
  running: "kører",
  succeeded: "gennemført",
  degraded: "gennemført med færre data end forventet",
  failed: "fejlet",
};
