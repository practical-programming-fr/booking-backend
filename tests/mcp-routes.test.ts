import { describe, expect, it } from "vitest";

const stubEnv = () => {
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "sb_publishable_stub";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "sb_secret_stub";
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
};

const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("mcp route", () => {
  it("handles initialize requests without touching the DB", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.0" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(body.result.serverInfo).toEqual({
      name: "flylo-booking-backend",
      version: "0.1.0",
    });
  });

  it("lists booking backend tools", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = body.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("search_flights");
    expect(toolNames).toContain("create_booking");
    expect(toolNames).toContain("release_expired_holds");
  });

  it("rejects invalid MCP transport headers before tool execution", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      }),
    });

    expect(res.status).toBe(406);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not acceptable/i);
  });
});
