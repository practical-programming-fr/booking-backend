// Seed script CLI wrapper. Core logic lives in src/domain/seed.ts so a future
// admin API can reuse the same reseed path.

import postgres from "postgres";
import { seedDatabase } from "../src/domain/seed.js";
import { loadEnv } from "../src/env.js";
import { parseSeedBaseDate } from "../src/lib/seed-date.js";

const SEED_DAYS = Number(process.env.SEED_DAYS ?? 45);

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    await seedDatabase(sql, {
      baseDate: parseSeedBaseDate(process.env.SEED_BASE_DATE),
      seedDays: SEED_DAYS,
    });
  } catch (err) {
    console.error("[seed] failed", err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();

