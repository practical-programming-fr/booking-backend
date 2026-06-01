import { describe, expect, it } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createBookingMcpServer,
  type InternalFetch,
} from "../src/mcp/server.js";

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

async function callToolWithFakeFetch(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const internalFetch: InternalFetch = async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ ok: true, path }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const server = createBookingMcpServer({
    internalFetch,
    env: { BOOKING_SESSION_HEADER: "x-booking-session" },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const res = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { ...mcpHeaders, ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const body = (await res.json()) as unknown;
    return { calls, res, body };
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

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
      result: {
        tools: Array<{
          name: string;
          inputSchema?: { properties?: Record<string, unknown> };
        }>;
      };
    };
    const toolNames = body.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("search_flights");
    expect(toolNames).toContain("create_booking");
    expect(toolNames).toContain("release_expired_holds");

    const createBooking = body.result.tools.find((tool) => tool.name === "create_booking");
    expect(createBooking?.inputSchema?.properties).not.toHaveProperty("sessionId");

    const releaseExpiredHolds = body.result.tools.find(
      (tool) => tool.name === "release_expired_holds",
    );
    expect(releaseExpiredHolds?.inputSchema?.properties).not.toHaveProperty("cronSecret");
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

  it("forwards the booking session header during tool calls", async () => {
    const { calls, body } = await callToolWithFakeFetch(
      "create_booking",
      {
        flightId: "00000000-0000-4000-8000-000000000000",
        cabin: "L",
        pax: 1,
      },
      { "x-booking-session": "11111111-1111-4111-8111-111111111111" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/bookings");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-booking-session": "11111111-1111-4111-8111-111111111111",
    });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        flightId: "00000000-0000-4000-8000-000000000000",
        cabin: "L",
        pax: 1,
      }),
    );
    expect(body).toMatchObject({ result: { structuredContent: { ok: true } } });
  });

  it("forwards Authorization for the hold-sweep tool without a tool secret argument", async () => {
    const { calls, body } = await callToolWithFakeFetch(
      "release_expired_holds",
      {},
      { Authorization: "Bearer test-secret" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/_cron/release-expired-holds");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-secret",
    });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(body).toMatchObject({ result: { structuredContent: { ok: true } } });
  });
});
