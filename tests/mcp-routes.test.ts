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

const stubMcpEnv = {
  BOOKING_SESSION_HEADER: "x-booking-session",
  DEMO_BOOKING_WEB_URL: "https://book.flylo-air.com",
  DEMO_CREW_WEB_URL: "https://crew.flylo-air.com",
} as const;

type FakeFetchOptions = {
  respond?: (path: string, init?: RequestInit) => Response;
  env?: Partial<Parameters<typeof createBookingMcpServer>[0]["env"]>;
};

async function callToolWithFakeFetch(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  options: FakeFetchOptions = {},
) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const internalFetch: InternalFetch = async (path, init) => {
    calls.push({ path, init });
    if (options.respond) {
      return options.respond(path, init);
    }
    return new Response(JSON.stringify({ ok: true, path }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const server = createBookingMcpServer({
    internalFetch,
    env: { ...stubMcpEnv, ...options.env },
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
    expect(toolNames).toContain("request_marketing_change");
    expect(toolNames).toContain("start_demo_outage");
    expect(toolNames).toContain("clear_demo_outage");

    // The scoped demo-outage tools must never take an ops secret as an
    // argument; the server injects OPS_SHARED_SECRET itself.
    const startDemoOutage = body.result.tools.find(
      (tool) => tool.name === "start_demo_outage",
    );
    expect(startDemoOutage?.inputSchema?.properties).not.toHaveProperty(
      "opsSharedSecret",
    );
    expect(startDemoOutage?.inputSchema?.properties).not.toHaveProperty(
      "authorization",
    );

    const createBooking = body.result.tools.find((tool) => tool.name === "create_booking");
    expect(createBooking?.inputSchema?.properties).not.toHaveProperty("sessionId");

    const releaseExpiredHolds = body.result.tools.find(
      (tool) => tool.name === "release_expired_holds",
    );
    expect(releaseExpiredHolds?.inputSchema?.properties).not.toHaveProperty("cronSecret");
  });

  it("arms and clears a scoped demo outage end-to-end through the /mcp route", async () => {
    stubEnv();
    // No OPS_SHARED_SECRET in dev: the internal /v1/_ops routes are open, and
    // the scoped session data layer fails safe to a computed row without a live
    // DB, so this exercises the full MCP -> /v1/_ops wiring.
    delete process.env.OPS_SHARED_SECRET;
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();

    const startRes = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "start_demo_outage",
          arguments: { ttlMinutes: 5 },
        },
      }),
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as {
      result: { structuredContent: { demoSessionId: string; ok: boolean; bookingSearchUrl: string } };
    };
    expect(startBody.result.structuredContent.ok).toBe(true);
    const sessionId = startBody.result.structuredContent.demoSessionId;
    expect(sessionId).toMatch(/[0-9a-f-]{36}/i);
    expect(startBody.result.structuredContent.bookingSearchUrl).toContain(
      `demo=${sessionId}`,
    );

    const clearRes = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "clear_demo_outage",
          arguments: { demoSessionId: sessionId },
        },
      }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as {
      result: { structuredContent: { ok: boolean; cleared: boolean; demoSessionId: string } };
    };
    expect(clearBody.result.structuredContent).toMatchObject({
      ok: true,
      cleared: true,
      demoSessionId: sessionId,
    });
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

  it("request_marketing_change degrades gracefully when Jira is not configured", async () => {
    const { body } = await callToolWithFakeFetch("request_marketing_change", {
      title: "Flash sale banner + FLASH20",
      description: "Add a weekend flash-sale banner and a 20 percent off code.",
      promoCode: "FLASH20",
      discountPercent: 20,
    });

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { configured: false },
      },
    });
  });

  it("start_demo_outage arms a scoped session and returns a session id plus links", async () => {
    const expiresAt = "2026-07-11T00:20:00.000Z";
    const { calls, body } = await callToolWithFakeFetch(
      "start_demo_outage",
      { slackChannel: "#incident-talal", ttlMinutes: 15 },
      {},
      {
        respond: (path) =>
          new Response(
            JSON.stringify({
              session: {
                id: "generated",
                sessionId: "generated",
                kind: "outage",
                slackChannel: "#incident-talal",
                runFullArc: true,
                createdAt: "2026-07-11T00:05:00.000Z",
                expiresAt,
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/_ops/demo-sessions");
    expect(calls[0]?.init?.method).toBe("POST");

    const requestBody = JSON.parse(String(calls[0]?.init?.body)) as {
      sessionId: string;
      ttlSeconds: number;
      slackChannel: string;
    };
    expect(requestBody.ttlSeconds).toBe(15 * 60);
    expect(requestBody.slackChannel).toBe("#incident-talal");
    expect(requestBody.sessionId).toMatch(/[0-9a-f-]{36}/i);

    const result = (body as { result: { structuredContent: Record<string, unknown> } })
      .result.structuredContent;
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("per-session");
    expect(result.ttlMinutes).toBe(15);
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.demoSessionId).toBe(requestBody.sessionId);
    expect(result.bookingSearchUrl).toBe(
      `https://book.flylo-air.com/search?demo=${requestBody.sessionId}`,
    );
    expect(result.crewNocUrl).toBe(
      `https://crew.flylo-air.com/ops?demo=${requestBody.sessionId}`,
    );
    // No secret leaks into the response.
    expect(JSON.stringify(result)).not.toMatch(/OPS_SHARED_SECRET|Bearer/i);
  });

  it("start_demo_outage reuses a supplied demoSessionId and defaults the TTL", async () => {
    const { calls, body } = await callToolWithFakeFetch("start_demo_outage", {
      demoSessionId: "sess-reuse-1",
    });

    const requestBody = JSON.parse(String(calls[0]?.init?.body)) as {
      sessionId: string;
      ttlSeconds: number;
    };
    expect(requestBody.sessionId).toBe("sess-reuse-1");
    expect(requestBody.ttlSeconds).toBe(20 * 60);

    const result = (body as { result: { structuredContent: Record<string, unknown> } })
      .result.structuredContent;
    expect(result.demoSessionId).toBe("sess-reuse-1");
    expect(result.ttlMinutes).toBe(20);
  });

  it("start_demo_outage injects OPS_SHARED_SECRET server-side when configured", async () => {
    const { calls } = await callToolWithFakeFetch(
      "start_demo_outage",
      { demoSessionId: "sess-auth" },
      {},
      { env: { OPS_SHARED_SECRET: "top-secret" } },
    );

    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer top-secret",
    });
  });

  it("clear_demo_outage disarms only the named scoped session", async () => {
    const { calls, body } = await callToolWithFakeFetch("clear_demo_outage", {
      demoSessionId: "sess-clear-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/_ops/demo-sessions/sess-clear-1");
    expect(calls[0]?.init?.method).toBe("DELETE");

    const result = (body as { result: { structuredContent: Record<string, unknown> } })
      .result.structuredContent;
    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(true);
    expect(result.demoSessionId).toBe("sess-clear-1");
  });

  it("clear_demo_outage surfaces a backend failure as an error result", async () => {
    const { body } = await callToolWithFakeFetch(
      "clear_demo_outage",
      { demoSessionId: "sess-fail" },
      {},
      {
        respond: () =>
          new Response(JSON.stringify({ error: { message: "boom", status: 500 } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      },
    );

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { ok: false, demoSessionId: "sess-fail" },
      },
    });
  });
});
