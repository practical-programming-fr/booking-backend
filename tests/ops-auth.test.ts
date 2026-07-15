// Service-principal auth for the ops-disruption endpoints. Covers the auth
// helper in isolation and the middleware behaviour on the mounted routes
// (401 without a token when one is configured, 503 in production without a
// token configured, and validation running once dev access is allowed).
//
// env.ts caches the parsed environment at module load, so each test resets the
// module registry (vi.resetModules) and imports fresh AFTER setting the env it
// needs. That way OPS_AGENT_TOKEN / NODE_ENV changes actually take effect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { constantTimeEqual } from "../src/lib/auth.js";

function stubEnv() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "sb_publishable_stub";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_stub";
  process.env.SUPABASE_DB_URL = "postgresql://stub:stub@localhost:5432/stub";
}

beforeEach(() => {
  vi.resetModules();
  stubEnv();
  delete process.env.OPS_AGENT_TOKEN;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  delete process.env.OPS_AGENT_TOKEN;
  delete process.env.NODE_ENV;
});

describe("constantTimeEqual", () => {
  it("matches equal strings and rejects mismatches", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(constantTimeEqual("s3cret-token", "s3cret-tokeX")).toBe(false);
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("requireOpsAgent middleware", () => {
  it("allows dev access and runs the handler when no token is configured", async () => {
    const { requireOpsAgent } = await import("../src/lib/auth.js");
    const app = new Hono<{ Variables: { opsPrincipal?: string } }>();
    app.use("*", requireOpsAgent());
    app.get("/probe", (c) => c.json({ principal: c.get("opsPrincipal") }));

    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: string };
    expect(body.principal).toBe("dev");
  });

  it("returns 503 in production when no token is configured", async () => {
    process.env.NODE_ENV = "production";
    const { requireOpsAgent } = await import("../src/lib/auth.js");
    const app = new Hono<{ Variables: { opsPrincipal?: string } }>();
    app.use("*", requireOpsAgent());
    app.get("/probe", (c) => c.json({ ok: true }));

    const res = await app.request("/probe");
    expect(res.status).toBe(503);
  });

  it("rejects a missing or wrong bearer token when configured", async () => {
    process.env.OPS_AGENT_TOKEN = "ops-token-value";
    const { requireOpsAgent } = await import("../src/lib/auth.js");
    const app = new Hono<{ Variables: { opsPrincipal?: string } }>();
    app.use("*", requireOpsAgent());
    app.get("/probe", (c) => c.json({ principal: c.get("opsPrincipal") }));

    const missing = await app.request("/probe");
    expect(missing.status).toBe(401);

    const wrong = await app.request("/probe", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("accepts the correct bearer token as the service principal", async () => {
    process.env.OPS_AGENT_TOKEN = "ops-token-value";
    const { requireOpsAgent } = await import("../src/lib/auth.js");
    const app = new Hono<{ Variables: { opsPrincipal?: string } }>();
    app.use("*", requireOpsAgent());
    app.get("/probe", (c) => c.json({ principal: c.get("opsPrincipal") }));

    const res = await app.request("/probe", {
      headers: { authorization: "Bearer ops-token-value" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: string };
    expect(body.principal).toBe("service");
  });
});

describe("ops-disruption routes wiring", () => {
  it("guards /v1/ops with the bearer token when configured", async () => {
    process.env.OPS_AGENT_TOKEN = "ops-token-value";
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const res = await app.request("/v1/ops/flights/FL228/passengers");
    expect(res.status).toBe(401);
  });

  it("validates the rebook body before any database work in dev", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    // Missing target flight (neither toFlightId nor toFlightNo) is rejected by
    // the validator, so the handler and DB are never reached.
    const res = await app.request("/v1/ops/rebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pnr: "DIS001", fromSegmentId: 1 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
