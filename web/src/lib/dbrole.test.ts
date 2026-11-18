import { describe, expect, it } from "vitest";
import { type LoginPrivileges, unsafeLoginReason } from "./dbrole";

const readOnly: LoginPrivileges = {
  superuser: false,
  createRole: false,
  createDb: false,
  writesTables: false,
};

describe("unsafeLoginReason", () => {
  it("accepts a read-only login", () => {
    expect(unsafeLoginReason(readOnly)).toBeNull();
  });

  it("rejects owner-like logins (regression: the owner URL copied into WEB_DATABASE_URL)", () => {
    expect(unsafeLoginReason({ ...readOnly, superuser: true })).toBe("the login is a superuser");
    // Neon's neondb_owner: CREATEROLE, CREATEDB and owner of the tables
    expect(
      unsafeLoginReason({ superuser: false, createRole: true, createDb: true, writesTables: true }),
    ).toBe("the login can create roles, can create databases, can write pipeline tables");
    expect(unsafeLoginReason({ ...readOnly, writesTables: true })).toBe(
      "the login can write pipeline tables",
    );
  });

  it("rejects an unknown login", () => {
    expect(unsafeLoginReason(undefined)).toBe("the login role was not found");
  });
});
