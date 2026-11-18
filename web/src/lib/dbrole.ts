/**
 * The web app's database login must not be able to write (architecture §7).
 *
 * The read-only role is the boundary; `default_transaction_read_only` on the session only guards
 * against accidental writes (any statement can switch it off). So the app refuses to serve when
 * `WEB_DATABASE_URL` logs in as a role that could write, e.g. the owner copied by mistake.
 */

/** Privileges of the current login, as returned by {@link ROLE_CHECK_SQL}. */
export interface LoginPrivileges {
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  /** INSERT, UPDATE or DELETE on a pipeline table (`public.listing`). */
  writesTables: boolean;
}

/** One row describing the current login (catalog lookups only; works for any role). */
export const ROLE_CHECK_SQL = `
  SELECT r.rolsuper AS superuser, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDb",
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'listing'
             AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE')
         ) AS "writesTables"
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user`;

/** Why the login is unsafe for the web app, or null when it is read-only. */
export function unsafeLoginReason(privileges: LoginPrivileges | undefined): string | null {
  if (!privileges) return "the login role was not found";
  const reasons: string[] = [];
  if (privileges.superuser) reasons.push("is a superuser");
  if (privileges.createRole) reasons.push("can create roles");
  if (privileges.createDb) reasons.push("can create databases");
  if (privileges.writesTables) reasons.push("can write pipeline tables");
  return reasons.length > 0 ? `the login ${reasons.join(", ")}` : null;
}
