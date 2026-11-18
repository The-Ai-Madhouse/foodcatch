import "server-only";

import postgres, { type Sql } from "postgres";
import { type LoginPrivileges, ROLE_CHECK_SQL, unsafeLoginReason } from "@/lib/dbrole";

/** Raised when the web app has no database connection configured. */
export class DatabaseConfigError extends Error {
  override name = "DatabaseConfigError";
}

// Survive hot reloads in development without leaking connection pools.
const globalForDb = globalThis as unknown as {
  foodcatchSql?: Sql;
  foodcatchLoginChecked?: Promise<void>;
};

/**
 * The shared connection pool (`WEB_DATABASE_URL`, architecture §7). Queries use
 * {@link readOnlyDb}, which also verifies the login once.
 *
 * The web app only reads the `api` views. The boundary is the read-only login role (a member of
 * `web_readonly`); sessions are also opened with `default_transaction_read_only`, which guards
 * against accidental writes only (defence in depth: any statement could switch it off).
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

/**
 * The pool, after checking once that `WEB_DATABASE_URL` logs in as a role that cannot write.
 *
 * @throws DatabaseConfigError if the login is a superuser, can create roles or databases, or can
 *   write pipeline tables (e.g. the owner URL was configured by mistake).
 */
export async function readOnlyDb(): Promise<Sql> {
  const sql = db();
  globalForDb.foodcatchLoginChecked ??= (async () => {
    const [privileges] = await sql.unsafe<LoginPrivileges[]>(ROLE_CHECK_SQL);
    const reason = unsafeLoginReason(privileges);
    if (reason) {
      throw new DatabaseConfigError(
        `WEB_DATABASE_URL must use a read-only login, but ${reason}; see web/README.md.`,
      );
    }
  })();
  try {
    await globalForDb.foodcatchLoginChecked;
  } catch (error) {
    globalForDb.foodcatchLoginChecked = undefined; // check again after a configuration fix
    throw error;
  }
  return sql;
}
