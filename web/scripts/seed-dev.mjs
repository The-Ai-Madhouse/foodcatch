// Load web/scripts/seed-dev.sql into a LOCAL development database.
//
// Usage: pnpm db:seed [--allow-remote]
// Connection: SEED_DATABASE_URL, default postgres://foodcatch:foodcatch@localhost:5432/foodcatch_web_dev
// (an owner connection: seeding writes, unlike the web app). The schema must already exist
// (`cd pipeline && DATABASE_URL=... uv run foodcatch db upgrade`).

import { readFile } from "node:fs/promises";
import postgres from "postgres";

const DEFAULT_URL = "postgres://foodcatch:foodcatch@localhost:5432/foodcatch_web_dev";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const rawUrl = process.env.SEED_DATABASE_URL || DEFAULT_URL;
// Accept SQLAlchemy-style URLs (postgresql+psycopg://) as used by the pipeline.
const url = rawUrl.replace(/^postgresql\+\w+:/, "postgresql:");
const parsed = new URL(url);

if (!LOCAL_HOSTS.has(parsed.hostname) && !process.argv.includes("--allow-remote")) {
  console.error(
    `Refusing to seed ${parsed.hostname}: the seed TRUNCATEs all data. ` +
      "Pass --allow-remote if this really is a development database.",
  );
  process.exit(1);
}

const sqlText = await readFile(new URL("./seed-dev.sql", import.meta.url), "utf8");
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(sqlText).simple();
  const [counts] = await sql`
    SELECT (SELECT count(*) FROM api.current_deals)::int AS deals,
           (SELECT count(*) FROM api.current_netto_deals)::int AS netto_deals,
           (SELECT count(*) FROM api.food_waste_near)::int AS food_waste,
           (SELECT count(*) FROM api.stores)::int AS stores,
           (SELECT count(*) FROM api.pipeline_status)::int AS jobs
  `;
  console.log(
    `Seeded ${parsed.pathname.slice(1)}: ${counts.deals} deal rows (${counts.netto_deals} ` +
      `Netto), ${counts.food_waste} ` +
      `food-waste items, ${counts.stores} stores, ${counts.jobs} jobs.`,
  );
} catch (error) {
  console.error("Seeding failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
