import { afterEach, describe, expect, it, vi } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  DemoOutageTriggerError,
  type ClearedDemoOutage,
  type DemoOutage,
  type TriggeredDemoOutage,
} from "../src/domain/demo-outage.js";
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

const DEMO_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_HANDLE = "test-run-handle-1234567890";

function createStatefulDemoOutages() {
  let prepared: DemoOutage | null = null;
  let bound = false;
  let active = false;
  let cleared = false;

  return {
    prepare: async (input: {
      ttlMinutes?: number;
      slackChannel?: string | null;
    }): Promise<DemoOutage> => {
      prepared = {
        demoSessionId: DEMO_SESSION_ID,
        activationToken: "test-activation-token",
        runHandle: RUN_HANDLE,
        expiresAt: "2026-08-01T14:00:00.000Z",
        ttlMinutes: input.ttlMinutes ?? 20,
      };
      bound = false;
      active = false;
      cleared = false;
      return prepared;
    },
    bindForTests: () => {
      if (!prepared || cleared) {
        throw new Error("nothing to bind");
      }
      bound = true;
    },
    trigger: async (runHandle: string): Promise<TriggeredDemoOutage> => {
      if (!prepared || prepared.runHandle !== runHandle || cleared) {
        throw new DemoOutageTriggerError(
          "outage_not_found",
          "No scoped demo outage matched that run handle.",
        );
      }
      if (!bound) {
        throw new DemoOutageTriggerError(
          "outage_not_bound",
          "Open the activation URL in the presenter browser before triggering the outage.",
        );
      }
      if (active) {
        throw new DemoOutageTriggerError(
          "outage_not_pending",
          "This scoped demo outage is not waiting to be triggered.",
        );
      }
      active = true;
      return {
        demoSessionId: prepared.demoSessionId,
        bookingSessionId: BOOKING_SESSION_ID,
        expiresAt: prepared.expiresAt,
      };
    },
    clear: async (runHandle: string): Promise<ClearedDemoOutage | null> => {
      if (!prepared || prepared.runHandle !== runHandle || cleared) {
        return null;
      }
      cleared = true;
      active = false;
      return { demoSessionId: prepared.demoSessionId };
    },
  };
}

async function callToolWithFakeFetch(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  demoOutages = createStatefulDemoOutages(),
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
    env: {
      BOOKING_SESSION_HEADER: "x-booking-session",
      DEMO_BOOKING_WEB_URL: "https://book.flylo-air.com",
      DEMO_CREW_WEB_URL: "https://crew.flylo-air.com",
    },
    demoOutages,
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
    return { calls, res, body, demoOutages };
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
    expect(toolNames).toContain("prepare_demo_outage");
    expect(toolNames).not.toContain("start_demo_outage");
    expect(toolNames).toContain("trigger_demo_outage");
    expect(toolNames).toContain("clear_demo_outage");

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
      { "x-booking-session": BOOKING_SESSION_ID },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/bookings");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-booking-session": BOOKING_SESSION_ID,
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

  it("uses CRON_SECRET for the hold-sweep tool, not the MCP bearer", async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-only-secret";
    try {
      const { calls, body } = await callToolWithFakeFetch(
        "release_expired_holds",
        {},
        { Authorization: "Bearer mcp-token-must-not-forward" },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe("/v1/_cron/release-expired-holds");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Bearer cron-only-secret",
      });
      expect(calls[0]?.init?.body).toBeUndefined();
      expect(body).toMatchObject({ result: { structuredContent: { ok: true } } });
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });

  it("request_marketing_change rejects an out-of-range discount percent", async () => {
    const { body } = await callToolWithFakeFetch("request_marketing_change", {
      title: "Flash sale banner",
      description: "Add a weekend flash-sale banner.",
      discountPercent: 120,
    });

    expect(body).toMatchObject({ result: { isError: true } });
    const text = (
      body as { result: { content: Array<{ text: string }> } }
    ).result.content[0]?.text;
    expect(text).toMatch(/less than or equal to 100/i);
  });

  it("request_marketing_change rejects endsAt before startsAt", async () => {
    const { body } = await callToolWithFakeFetch("request_marketing_change", {
      title: "Flash sale banner",
      description: "Add a weekend flash-sale banner.",
      startsAt: "2026-07-13",
      endsAt: "2026-07-11",
    });

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: "invalid_dates" },
      },
    });
  });

  it("request_marketing_change reports when Jira is not configured", async () => {
    const { body } = await callToolWithFakeFetch("request_marketing_change", {
      title: "Flash sale banner",
      description: "Add a weekend flash-sale banner.",
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

  it("prepare_demo_outage returns a bind-only activation URL", async () => {
    const { calls, body } = await callToolWithFakeFetch("prepare_demo_outage", {
      ttlMinutes: 20,
    });

    expect(calls).toHaveLength(0);
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          demoSessionId: DEMO_SESSION_ID,
          runHandle: RUN_HANDLE,
          scope: "browser-session",
          activationUrl:
            "https://book.flylo-air.com/demo/activate?token=test-activation-token",
          ttlMinutes: 20,
          expiresAt: "2026-08-01T14:00:00.000Z",
        },
      },
    });
    const instructions = (
      body as {
        result: { structuredContent: { instructions: string } };
      }
    ).result.structuredContent.instructions;
    expect(instructions).toMatch(/BIND/i);
    expect(instructions).toMatch(/trigger_demo_outage/);
  });

  it("trigger_demo_outage fails before the browser is bound", async () => {
    const demoOutages = createStatefulDemoOutages();
    await callToolWithFakeFetch("prepare_demo_outage", { ttlMinutes: 20 }, {}, demoOutages);

    const { body } = await callToolWithFakeFetch(
      "trigger_demo_outage",
      { runHandle: RUN_HANDLE },
      {},
      demoOutages,
    );

    expect(body).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          code: "outage_not_bound",
        },
      },
    });
  });

  it("trigger_demo_outage succeeds after a simulated bind", async () => {
    const demoOutages = createStatefulDemoOutages();
    await callToolWithFakeFetch("prepare_demo_outage", { ttlMinutes: 20 }, {}, demoOutages);
    demoOutages.bindForTests();

    const { body } = await callToolWithFakeFetch(
      "trigger_demo_outage",
      { runHandle: RUN_HANDLE },
      {},
      demoOutages,
    );

    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          demoSessionId: DEMO_SESSION_ID,
          bookingSessionId: BOOKING_SESSION_ID,
          expiresAt: "2026-08-01T14:00:00.000Z",
        },
      },
    });
  });

  it("clears only the requested scoped outage", async () => {
    const demoOutages = createStatefulDemoOutages();
    await callToolWithFakeFetch("prepare_demo_outage", { ttlMinutes: 20 }, {}, demoOutages);
    demoOutages.bindForTests();
    await callToolWithFakeFetch(
      "trigger_demo_outage",
      { runHandle: RUN_HANDLE },
      {},
      demoOutages,
    );

    const { calls, body } = await callToolWithFakeFetch(
      "clear_demo_outage",
      { runHandle: RUN_HANDLE },
      {},
      demoOutages,
    );

    expect(calls).toHaveLength(0);
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          demoSessionId: DEMO_SESSION_ID,
          cleared: true,
        },
      },
    });
  });
});

describe("mcp bearer auth (FLYLO_MCP_TOKEN)", () => {
  // loadEnv caches per module registry, so each case rebuilds the app with a
  // fresh registry to pick up the env change.
  async function freshApp(token: string | undefined) {
    vi.resetModules();
    stubEnv();
    if (token === undefined) {
      delete process.env.FLYLO_MCP_TOKEN;
    } else {
      process.env.FLYLO_MCP_TOKEN = token;
    }
    const { buildApp } = await import("../src/app.js");
    return buildApp();
  }

  const listTools = async (
    app: Awaited<ReturnType<typeof freshApp>>,
    headers: Record<string, string> = {},
  ) =>
    app.request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  afterEach(async () => {
    delete process.env.FLYLO_MCP_TOKEN;
    vi.resetModules();
  });

  it("returns 401 without the bearer token when configured", async () => {
    const app = await freshApp("mcp-secret");
    const res = await listTools(app);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Unauthorized" },
    });
  });

  it("returns 401 for a wrong bearer token", async () => {
    const app = await freshApp("mcp-secret");
    const res = await listTools(app, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("serves the request with the correct bearer token", async () => {
    const app = await freshApp("mcp-secret");
    const res = await listTools(app, { Authorization: "Bearer mcp-secret" });
    expect(res.status).toBe(200);
  });

  it("stays open when the token is unset", async () => {
    const app = await freshApp(undefined);
    const res = await listTools(app);
    expect(res.status).toBe(200);
  });
});
