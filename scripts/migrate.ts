// Hand-rolled migration runner.
//
// Reads SQL files from `supabase/migrations/*.sql`, applies them in
// lexicographic order, and records which files have been applied in a
// `_migrations` table. If the Supabase CLI ledger exists, matching migration
// names are reconciled before pending files are applied.
//
// Usage:
//   npm run db:migrate          # apply any new migrations
//   npm run db:migrate --reset  # reset a local public schema, then apply all

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadEnv } from "../src/env.js";
import { assertLocalDatabaseReset } from "./database-reset-safety.js";
import {
  assertMigrationOrder,
  findSupabaseLedgerMatches,
} from "./migration-ledger.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");

async function listMigrations(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith(".sql")).sort();
}

async function main(): Promise<void> {
  const env = loadEnv();
  const reset = process.argv.includes("--reset");
  if (reset) {
    assertLocalDatabaseReset(env.SUPABASE_DB_URL);
  }

  const sql = postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    if (reset) {
      console.log("[migrate] resetting public schema");
      await sql.unsafe(`
        drop schema if exists public cascade;
        create schema public;
        grant usage on schema public to anon, authenticated, service_role;
        grant all on schema public to postgres;
      `);
    }

    await sql.unsafe(`
      create table if not exists public._migrations (
        name        text primary key,
        applied_at  timestamptz not null default now()
      );
    `);

    const applied = new Set(
      (await sql<{ name: string }[]>`select name from public._migrations`).map(
        (row) => row.name,
      ),
    );

    const files = await listMigrations();

    if (!reset) {
      const [supabaseLedger] = await sql<{ exists: boolean }[]>`
        select to_regclass(
          'supabase_migrations.schema_migrations'
        ) is not null as exists
      `;

      if (supabaseLedger?.exists) {
        const supabaseMigrations = await sql<
          { version: string; name: string | null }[]
        >`
          select version, name
          from supabase_migrations.schema_migrations
        `;
        const reconciled = findSupabaseLedgerMatches({
          repositoryFiles: files,
          appliedFiles: applied,
          supabaseMigrations,
        });

        if (reconciled.length > 0) {
          await sql.begin(async (tx) => {
            for (const match of reconciled) {
              await tx`
                insert into public._migrations (name)
                values (${match.repositoryFileName})
                on conflict (name) do nothing
              `;
            }
          });
        }

        for (const match of reconciled) {
          applied.add(match.repositoryFileName);
          console.log(
            `[migrate] reconciled ${match.repositoryFileName} from Supabase ${match.supabaseVersion}`,
          );
        }

        console.log(
          `[migrate] reconciled ${reconciled.length} migration(s) from Supabase ledger`,
        );
      }
    }

    assertMigrationOrder({
      repositoryFiles: files,
      appliedFiles: applied,
    });
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log("[migrate] nothing to apply");
      return;
    }

    for (const file of pending) {
      const path = resolve(MIGRATIONS_DIR, file);
      const body = await readFile(path, "utf8");
      console.log(`[migrate] applying ${file}`);

      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into public._migrations (name) values (${file})`;
      });
    }

    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } catch (err) {
    console.error("[migrate] failed", err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
