/**
 * Pipeline health shown on /status: how fresh each job's data is, given its schedule
 * (architecture §4 "Jobs and schedules"). Pure and unit tested.
 */

import type { Tone } from "./deals";

export interface JobDefinition {
  job: string;
  label: string;
  schedule: string;
  /** Older than this (since the last finished run) counts as late: one scheduled run is missing. */
  lateAfterHours: number;
  /** Older than this counts as stale: several scheduled runs are missing. */
  maxAgeHours: number;
}

/**
 * Jobs and schedules from architecture §4. GitHub starts scheduled runs up to ~10 hours late and
 * sometimes skips one (observed November 2026), so a job only counts as late after one whole
 * missed run plus that delay, and as stale (prices may be old) after two.
 */
export const JOBS: readonly JobDefinition[] = [
  {
    job: "tjek-offers",
    label: "Tilbudsaviser (Tjek)",
    schedule: "Dagligt",
    lateAfterHours: 36,
    maxAgeHours: 60,
  },
  {
    job: "salling-food-waste",
    label: "Madspild (Salling Group)",
    schedule: "To gange dagligt",
    lateAfterHours: 26,
    maxAgeHours: 50,
  },
  {
    job: "rema-products",
    label: "REMA 1000-sortiment",
    schedule: "Dagligt",
    lateAfterHours: 36,
    maxAgeHours: 60,
  },
  {
    job: "off-enrich",
    label: "Open Food Facts",
    schedule: "Dagligt",
    lateAfterHours: 36,
    maxAgeHours: 60,
  },
  {
    job: "tjek-stores",
    label: "Butikker (Tjek)",
    schedule: "Ugentligt",
    lateAfterHours: 8 * 24,
    maxAgeHours: 15 * 24,
  },
  {
    job: "salling-stores",
    label: "Butikker (Salling Group)",
    schedule: "Ugentligt",
    lateAfterHours: 8 * 24,
    maxAgeHours: 15 * 24,
  },
];

/** A running job older than this is probably stuck (jobs time out well before). */
export const STUCK_AFTER_HOURS = 2;

export interface PipelineRun {
  job: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

export type JobHealth =
  "ok" | "running" | "degraded" | "late" | "stale" | "stuck" | "failed" | "never";

export const HEALTH_META: Readonly<Record<JobHealth, { label: string; tone: Tone }>> = {
  ok: { label: "OK", tone: "good" },
  running: { label: "Kører", tone: "neutral" },
  degraded: { label: "Forringet", tone: "warn" },
  late: { label: "Forsinket", tone: "warn" },
  stale: { label: "Forældet", tone: "bad" },
  stuck: { label: "Hænger", tone: "bad" },
  failed: { label: "Fejlet", tone: "bad" },
  never: { label: "Aldrig kørt", tone: "warn" },
};

export const REVIEW_REASON_LABELS: Readonly<Record<string, string>> = {
  unrecognized_staple_word: "Basisvare-ord uden genkendt vare",
  unknown_key_attribute: "Ukendt nøgle-egenskab",
  ambiguous_offer: "Tilbud med flere forskellige varer",
};

export interface JobAssessment {
  job: string;
  label: string;
  schedule: string | null;
  health: JobHealth;
  run: PipelineRun | null;
  /** Hours since the last finished (or started, if unfinished) run. */
  ageHours: number | null;
  maxAgeHours: number | null;
}

const HOUR_MS = 3_600_000;

/** Assess one job's latest run against its schedule. */
export function assessJob(
  def: Pick<JobDefinition, "job" | "label"> & Partial<JobDefinition>,
  run: PipelineRun | null,
  now: Date,
): JobAssessment {
  const base = {
    job: def.job,
    label: def.label,
    schedule: def.schedule ?? null,
    maxAgeHours: def.maxAgeHours ?? null,
    run,
  };
  if (!run) return { ...base, health: "never", ageHours: null };

  const last = new Date(run.finishedAt ?? run.startedAt);
  const ageHours = (now.getTime() - last.getTime()) / HOUR_MS;
  let health: JobHealth;
  if (run.status === "running") {
    health = ageHours > STUCK_AFTER_HOURS ? "stuck" : "running";
  } else if (run.status === "failed") {
    health = "failed";
  } else if (def.maxAgeHours != null && ageHours > def.maxAgeHours) {
    health = "stale";
  } else if (def.lateAfterHours != null && ageHours > def.lateAfterHours) {
    health = "late";
  } else if (run.status === "degraded") {
    health = "degraded";
  } else {
    health = "ok";
  }
  return { ...base, health, ageHours };
}

/** Assess all known jobs plus any other job that appears in `runs`. */
export function assessPipeline(runs: readonly PipelineRun[], now: Date): JobAssessment[] {
  const byJob = new Map(runs.map((r) => [r.job, r]));
  const known = JOBS.map((def) => assessJob(def, byJob.get(def.job) ?? null, now));
  const extra = runs
    .filter((r) => !JOBS.some((def) => def.job === r.job))
    .map((r) => assessJob({ job: r.job, label: r.job }, r, now));
  return [...known, ...extra];
}

/** The overall tone: the worst tone of any job. */
export function overallTone(assessments: readonly JobAssessment[]): Tone {
  const tones = assessments.map((a) => HEALTH_META[a.health].tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  if (tones.length > 0 && tones.every((t) => t === "good")) return "good";
  return "neutral";
}

/** Numeric top-level entries of `fetch_run.stats`, for a compact summary. */
export function summarizeStats(stats: Record<string, unknown>, limit = 6): [string, number][] {
  return Object.entries(stats)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .slice(0, limit);
}
