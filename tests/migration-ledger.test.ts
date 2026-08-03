import { describe, expect, it } from "vitest";
import { findSupabaseLedgerMatches } from "../scripts/migration-ledger.js";

const supabaseMigration = (version: string, name: string | null) => ({
  version,
  name,
});

describe("findSupabaseLedgerMatches", () => {
  it("reconciles a repository file by name when the CLI timestamp differs", () => {
    const supabaseLedgerRow = {
      version: "20260802003053",
      name: "ops_demo_outages",
    };

    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: ["20260801140000_ops_demo_outages.sql"],
        appliedFiles: new Set(),
        supabaseMigrations: [supabaseLedgerRow],
      }),
    ).toEqual([
      {
        repositoryFileName: "20260801140000_ops_demo_outages.sql",
        supabaseVersion: "20260802003053",
      },
    ]);
  });

  it("does not reconcile files already recorded in the app ledger", () => {
    const fileName = "20260801140000_ops_demo_outages.sql";

    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: [fileName],
        appliedFiles: new Set([fileName]),
        supabaseMigrations: [
          supabaseMigration("20260802003053", "ops_demo_outages"),
        ],
      }),
    ).toEqual([]);
  });

  it("leaves unrelated names and malformed repository files unmatched", () => {
    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: [
          "ops_demo_outages.sql",
          "20260801140000_.sql",
          "20260801140000_ops_demo_outages.txt",
          "20260801150000_other_migration.sql",
        ],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260802003053", "ops_demo_outages"),
          supabaseMigration("20260802003054", "unrelated_migration"),
        ],
      }),
    ).toEqual([]);
  });

  it("preserves repository file order", () => {
    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: [
          "20260801150000_second_migration.sql",
          "20260801140000_first_migration.sql",
        ],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260802003053", "first_migration"),
          supabaseMigration("20260802003054", "second_migration"),
        ],
      }),
    ).toEqual([
      {
        repositoryFileName: "20260801150000_second_migration.sql",
        supabaseVersion: "20260802003054",
      },
      {
        repositoryFileName: "20260801140000_first_migration.sql",
        supabaseVersion: "20260802003053",
      },
    ]);
  });

  it("matches an unnamed Supabase repair by exact version", () => {
    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: ["20260801140000_ops_demo_outages.sql"],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260801140000", null),
          supabaseMigration("20260801150000", ""),
        ],
      }),
    ).toEqual([
      {
        repositoryFileName: "20260801140000_ops_demo_outages.sql",
        supabaseVersion: "20260801140000",
      },
    ]);
  });

  it("rejects duplicate repository migration names", () => {
    expect(() =>
      findSupabaseLedgerMatches({
        repositoryFiles: [
          "20260801140000_duplicate_name.sql",
          "20260801150000_duplicate_name.sql",
        ],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260802003053", "duplicate_name"),
        ],
      }),
    ).toThrow('Duplicate repository migration name "duplicate_name"');
  });

  it("uses the latest duplicate Supabase name", () => {
    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: ["20260801140000_duplicate_name.sql"],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260801150000", "duplicate_name"),
          supabaseMigration("20260801160000", "duplicate_name"),
        ],
      }),
    ).toEqual([
      {
        repositoryFileName: "20260801140000_duplicate_name.sql",
        supabaseVersion: "20260801160000",
      },
    ]);
  });

  it("trims Supabase migration names", () => {
    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: ["20260801140000_padded_name.sql"],
        appliedFiles: new Set(),
        supabaseMigrations: [
          supabaseMigration("20260801150000", "  padded_name  "),
        ],
      }),
    ).toEqual([
      {
        repositoryFileName: "20260801140000_padded_name.sql",
        supabaseVersion: "20260801150000",
      },
    ]);
  });
});
