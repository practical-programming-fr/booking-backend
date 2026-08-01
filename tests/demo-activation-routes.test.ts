import { describe, expect, it } from "vitest";

function stubEnv(): void {
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
  process.env.BOOKING_SESSION_HEADER ??= "x-booking-session";
}

describe("POST /v1/demo/activate", () => {
  it("requires a valid booking session header", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const response = await buildApp().request("/v1/demo/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "activation-token-that-is-long-enough-for-validation",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "booking_session_required" },
    });
  });

  it("rejects a malformed activation token", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const response = await buildApp().request("/v1/demo/activate", {
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
