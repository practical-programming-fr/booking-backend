import { describe, expect, it } from "vitest";
import { findSupabaseLedgerMatches } from "../scripts/migration-ledger.js";

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
        supabaseMigrationNames: new Set([supabaseLedgerRow.name]),
      }),
    ).toEqual(["20260801140000_ops_demo_outages.sql"]);
  });

  it("does not reconcile files already recorded in the app ledger", () => {
    const fileName = "20260801140000_ops_demo_outages.sql";

    expect(
      findSupabaseLedgerMatches({
        repositoryFiles: [fileName],
        appliedFiles: new Set([fileName]),
        supabaseMigrationNames: new Set(["ops_demo_outages"]),
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
        supabaseMigrationNames: new Set([
          "ops_demo_outages",
          "unrelated_migration",
        ]),
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
        supabaseMigrationNames: new Set([
          "first_migration",
          "second_migration",
        ]),
      }),
    ).toEqual([
      "20260801150000_second_migration.sql",
      "20260801140000_first_migration.sql",
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
        supabaseMigrationNames: new Set(["duplicate_name"]),
      }),
    ).toThrow('Duplicate repository migration name "duplicate_name"');
  });
});
