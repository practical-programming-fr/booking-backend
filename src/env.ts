import { z } from "zod";

const envSchema = z
  .object({
    // The database connection is the only Supabase value the backend
    // actually uses. `DATABASE_URL` is accepted as an alias so the stack
    // can run against a plain local Postgres without hosted Supabase.
    SUPABASE_DB_URL: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),

    // Hosted Supabase client keys are reserved for future auth/realtime
    // work and are not required to run the booking API locally.
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

    PORT: z
      .string()
      .optional()
      .default("8787")
      .transform((value) => Number.parseInt(value, 10)),

    BOOKING_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .default("http://localhost:3000")
      .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),

    BOOKING_SESSION_HEADER: z
      .string()
      .optional()
      .default("x-booking-session"),

    // Jira Cloud integration for the request_marketing_change MCP tool. All
    // optional: when any are missing the tool degrades gracefully and reports
    // that Jira is not configured, so local dev and the build work without
    // credentials. Provide the secrets through the deployment platform; never
    // commit them.
    JIRA_BASE_URL: z.string().url().optional(),
    JIRA_EMAIL: z.string().email().optional(),
    JIRA_API_TOKEN: z.string().min(1).optional(),
    JIRA_PROJECT_KEY: z.string().min(1).optional(),

    NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),
  })
  .transform((value) => ({
    ...value,
    // Normalize to a single connection string used everywhere downstream.
    SUPABASE_DB_URL: value.SUPABASE_DB_URL ?? value.DATABASE_URL ?? "",
  }))
  .refine((value) => value.SUPABASE_DB_URL.length > 0, {
    message:
      "Set SUPABASE_DB_URL (or DATABASE_URL) to a Postgres connection string. " +
      "For local dev see booking-backend/docker-compose.yml.",
    path: ["SUPABASE_DB_URL"],
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) {
    return cached;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
