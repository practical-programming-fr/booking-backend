import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "../env.js";
import * as schema from "./schema.js";

let cached: ReturnType<typeof drizzle<typeof schema>> | undefined;
let cachedClient: ReturnType<typeof postgres> | undefined;

export function getDb() {
  if (cached) {
    return cached;
  }
  const env = loadEnv();
  cachedClient = postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  cached = drizzle(cachedClient, { schema });
  return cached;
}

export function getSql() {
  if (!cachedClient) {
    getDb();
  }
  return cachedClient!;
}

export async function closeDb(): Promise<void> {
  if (cachedClient) {
    await cachedClient.end({ timeout: 5 });
    cachedClient = undefined;
    cached = undefined;
  }
}
