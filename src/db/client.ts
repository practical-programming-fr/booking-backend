import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "../env.js";
import * as schema from "./schema.js";

let cached: ReturnType<typeof drizzle<typeof schema>> | undefined;
let drizzleClient: ReturnType<typeof postgres> | undefined;
let sqlClient: ReturnType<typeof postgres> | undefined;

function makeClient() {
  const env = loadEnv();
  return postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export function getDb() {
  if (cached) {
    return cached;
  }
  drizzleClient = makeClient();
  cached = drizzle(drizzleClient, { schema });
  return cached;
}

// Raw postgres.js client used for the booking/payments/seats domain logic
// that issues hand-written tagged-template SQL. Kept separate from the
// drizzle-wrapped client because drizzle replaces postgres.js's built-in
// type parsers, which would cause timestamptz columns to come back as raw
// strings instead of Date instances.
export function getSql() {
  if (!sqlClient) {
    sqlClient = makeClient();
  }
  return sqlClient;
}

export async function closeDb(): Promise<void> {
  const closes: Array<Promise<unknown>> = [];
  if (drizzleClient) {
    closes.push(drizzleClient.end({ timeout: 5 }));
    drizzleClient = undefined;
    cached = undefined;
  }
  if (sqlClient) {
    closes.push(sqlClient.end({ timeout: 5 }));
    sqlClient = undefined;
  }
  await Promise.all(closes);
}
