// Wipe all data from the booking schema, leaving the schema itself
// intact. Useful when you want a clean slate but don't want to re-run
// migrations. The seed script is then safe to run from scratch.
//
// Cascade order matters: payments/passengers/segments → bookings;
// seat_holds → flight_seats → flight_fares → flights; then catalog
// rows. Profiles aren't currently used by the v1 frontend but we wipe
// them too for symmetry.
//
// To wipe AND re-seed: `npm run db:reseed`.
// To wipe AND re-migrate AND re-seed: `npm run db:reset`.

import postgres from "postgres";
import { loadEnv } from "../src/env.js";

const TABLES_IN_ORDER = [
  "payments",
  "passengers",
  "booking_segments",
  "seat_holds",
  "bookings",
  "flight_seats",
  "flight_fares",
  "flights",
  "routes",
  "seat_map_templates",
  "meals",
  "cabins",
  "aircraft_types",
  "airports",
  "profiles",
];

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    console.log("[wipe] truncating tables");
    for (const table of TABLES_IN_ORDER) {
      await sql.unsafe(`truncate table public.${table} restart identity cascade`);
      console.log(`[wipe]   · ${table}`);
    }
    console.log("[wipe] done");
  } catch (err) {
    console.error("[wipe] failed", err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
