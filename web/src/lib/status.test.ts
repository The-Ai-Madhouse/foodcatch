import { describe, expect, it } from "vitest";
import {
  JOBS,
  type PipelineRun,
  assessJob,
  assessPipeline,
  overallTone,
  summarizeStats,
} from "./status";

const now = new Date("2026-11-18T12:00:00Z");
const daily = { job: "tjek-offers", label: "Tilbudsaviser", maxAgeHours: 30 };

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    job: "tjek-offers",
    status: "succeeded",
    startedAt: "2026-11-18T04:07:00Z",
    finishedAt: "2026-11-18T04:12:00Z",
    stats: { records: 1234 },
    error: null,
    ...overrides,
  };
}

describe("assessJob", () => {
  it("is ok for a recent successful run", () => {
    const a = assessJob(daily, run(), now);
    expect(a.health).toBe("ok");
    expect(a.ageHours).toBeCloseTo(7.8, 1);
  });

  it("flags a job that has never run", () => {
    expect(assessJob(daily, null, now).health).toBe("never");
  });

  it("flags stale data even when the last run succeeded", () => {
    const old = run({ startedAt: "2026-11-16T04:07:00Z", finishedAt: "2026-11-16T04:12:00Z" });
    expect(assessJob(daily, old, now).health).toBe("stale");
  });

  it("reports failures and degraded runs", () => {
    expect(assessJob(daily, run({ status: "failed", error: "boom" }), now).health).toBe("failed");
    expect(assessJob(daily, run({ status: "degraded" }), now).health).toBe("degraded");
  });

  it("distinguishes running from stuck", () => {
    const running = run({ status: "running", startedAt: "2026-11-18T11:30:00Z", finishedAt: null });
    expect(assessJob(daily, running, now).health).toBe("running");
    const stuck = run({ status: "running", startedAt: "2026-11-18T06:00:00Z", finishedAt: null });
    expect(assessJob(daily, stuck, now).health).toBe("stuck");
  });

  it("does not judge freshness of unknown jobs", () => {
    const old = run({ job: "x", startedAt: "2020-01-01T00:00:00Z", finishedAt: null });
    expect(assessJob({ job: "x", label: "x" }, old, now).health).toBe("ok");
  });
});

describe("assessPipeline", () => {
  it("lists every known job plus unknown ones", () => {
    const result = assessPipeline([run(), run({ job: "custom" })], now);
    expect(result).toHaveLength(JOBS.length + 1);
    expect(result.find((a) => a.job === "tjek-offers")?.health).toBe("ok");
    expect(result.find((a) => a.job === "rema-products")?.health).toBe("never");
    expect(result.at(-1)?.job).toBe("custom");
  });
});

describe("overallTone", () => {
  it("returns the worst tone", () => {
    const ok = assessJob(daily, run(), now);
    const failed = assessJob(daily, run({ status: "failed" }), now);
    const never = assessJob(daily, null, now);
    expect(overallTone([ok])).toBe("good");
    expect(overallTone([ok, never])).toBe("warn");
    expect(overallTone([ok, never, failed])).toBe("bad");
    expect(overallTone([])).toBe("neutral");
  });
});

describe("summarizeStats", () => {
  it("keeps numeric top-level entries", () => {
    expect(summarizeStats({ records: 10, nested: { a: 1 }, note: "x", listings: 3 })).toEqual([
      ["records", 10],
      ["listings", 3],
    ]);
  });
});
