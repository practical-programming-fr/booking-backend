// Lightweight route-mounting tests. We assert the new endpoints are wired
// in and respond with the right validation behaviour, without requiring a
// live DB connection. End-to-end booking tests are deferred to integration
// tests against a seeded Supabase instance.

import { describe, expect, it } from "vitest";

const stubEnv = () => {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "sb_publishable_stub";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "sb_secret_stub";
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
};

describe("booking routes", () => {
  it("rejects POST /v1/bookings without a session header", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const res = await app.request("/v1/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flightId: "00000000-0000-4000-8000-000000000000",
        cabin: "L",
        pax: 1,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/session/i);
  });

  it("rejects POST /v1/bookings with a bad body", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const res = await app.request("/v1/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-booking-session": "11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify({ flightId: "not-a-uuid", cabin: "X", pax: 99 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("me routes", () => {
  it("returns an empty trips list when no session header is provided", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const res = await app.request("/v1/me/trips");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trips: unknown[] };
    expect(body.trips).toEqual([]);
  });
});

describe("cron route", () => {
  it("requires the CRON_SECRET when configured", async () => {
    stubEnv();
    process.env.CRON_SECRET = "topsecret";
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const res = await app.request("/v1/_cron/release-expired-holds", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });
});
