import { describe, expect, it } from "vitest";

const stubEnv = () => {
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
};

describe("demo activation route", () => {
  it("requires the browser booking session", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const response = await app.request("/v1/demo/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(43) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "booking_session_required" },
    });
  });

  it("validates the one-time activation token before database access", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const response = await app.request("/v1/demo/activate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-booking-session": "11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify({ token: "short" }),
    });

    expect(response.status).toBe(400);
  });
});
