import "server-only";

import postgres, { type Sql } from "postgres";

/** Raised when the web app has no database connection configured. */
export class DatabaseConfigError extends Error {
  override name = "DatabaseConfigError";
}

// Survive hot reloads in development without leaking connection pools.
const globalForDb = globalThis as unknown as { foodcatchSql?: Sql };

/**
 * The shared read-only connection pool (`WEB_DATABASE_URL`, architecture §7).
 *
 * The web app only reads the `api` views. Every session is additionally opened with
 * `default_transaction_read_only`, so an accidental write fails even with an owner connection.
 */
export function db(): Sql {
  if (globalForDb.foodcatchSql) return globalForDb.foodcatchSql;
  const url = process.env.WEB_DATABASE_URL;
  if (!url) {
    throw new DatabaseConfigError(
      "WEB_DATABASE_URL is not set; see web/README.md for the local setup.",
    );
  }
  const sql = postgres(url, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    connection: {
      application_name: "foodcatch-web",
      default_transaction_read_only: true,
      statement_timeout: 15_000,
    },
  });
  globalForDb.foodcatchSql = sql;
  return sql;
}
