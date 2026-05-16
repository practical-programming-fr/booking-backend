import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("imports the Hono app without throwing (env may not be set)", async () => {
    try {
      // Stub minimum env so the schema can pass.
      process.env.SUPABASE_URL ??= "https://example.supabase.co";
      process.env.SUPABASE_ANON_KEY ??= "sb_publishable_stub";
      process.env.SUPABASE_SERVICE_ROLE_KEY ??= "sb_secret_stub";
      process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";

      const { buildApp } = await import("../src/app.js");
      const app = buildApp();
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("flylo-booking-backend");
    } catch (err) {
      throw err;
    }
  });
});
