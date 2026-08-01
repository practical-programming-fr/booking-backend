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

    // Per-session (scoped) outage identity. The frontend forwards the demo
    // presenter's session id in this header so the backend can break the site
    // for that one session only, leaving everyone else healthy. Distinct from
    // BOOKING_SESSION_HEADER (which identifies a booking owner) so the two
    // concerns stay independent.
    DEMO_SESSION_HEADER: z
      .string()
      .optional()
      .default("x-demo-session"),

    // How long an armed scoped outage session stays active before it lapses.
    // Defaults to 1200 seconds (20 minutes), matching the outage TTL.
    DEMO_SESSION_TTL_SECONDS: z
      .string()
      .optional()
      .default("1200")
      .transform((value) => Number.parseInt(value, 10)),

    // Bearer token identifying the external FlyLo Ops Agent as a service
    // principal. Optional so local dev works without it. When set, the
    // agent-facing ops-disruption endpoints under /v1/ops require
    // `Authorization: Bearer <OPS_AGENT_TOKEN>`. Distinct from the browser
    // BOOKING_SESSION_HEADER identity and from OPS_SHARED_SECRET (which guards
    // the /v1/_ops incident console). Provide as a platform secret; never
    // commit it.
    OPS_AGENT_TOKEN: z.string().min(1).optional(),

    // Shared secret guarding the /v1/_ops incident console. When set
    // (production), every /v1/_ops route requires
    // `Authorization: Bearer <OPS_SHARED_SECRET>`. Unset in local dev so the
    // console (and the scoped demo-outage MCP tools) work without ceremony. The
    // scoped demo-outage MCP tools read this server-side and inject it
    // themselves when calling the internal ops session API, so the calling
    // agent never needs the secret. Provide as a platform secret; never commit
    // it and never return it in a tool response or log.
    OPS_SHARED_SECRET: z.string().min(1).optional(),

    // Public web origins used to build the browser activation URL and the
    // backward-compatible booking and crew demo links returned by MCP.
    // Defaults match the FlyLo demo domains; override per environment if the
    // hostnames differ. These are public URLs, not secrets.
    DEMO_BOOKING_WEB_URL: z
      .string()
      .url()
      .optional()
      .default("https://book.flylo-air.com"),
    DEMO_CREW_WEB_URL: z
      .string()
      .url()
      .optional()
      .default("https://crew.flylo-air.com"),

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
