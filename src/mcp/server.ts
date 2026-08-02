import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DemoOutageTriggerError,
  type ClearedDemoOutage,
  type DemoOutage,
  type TriggeredDemoOutage,
} from "../domain/demo-outage.js";
import type { Env } from "../env.js";
import { createMarketingIssue } from "../lib/jira.js";

export type InternalFetch = (path: string, init?: RequestInit) => Promise<Response>;

type BookingMcpServerOptions = {
  internalFetch: InternalFetch;
  env: Pick<
    Env,
    | "BOOKING_SESSION_HEADER"
    | "OPS_SHARED_SECRET"
    | "DEMO_BOOKING_WEB_URL"
    | "DEMO_CREW_WEB_URL"
    | "JIRA_BASE_URL"
    | "JIRA_EMAIL"
    | "JIRA_API_TOKEN"
    | "JIRA_PROJECT_KEY"
  >;
  demoOutages: {
    prepare: (input: {
      ttlMinutes?: number;
      slackChannel?: string | null;
    }) => Promise<DemoOutage>;
    trigger: (runHandle: string) => Promise<TriggeredDemoOutage>;
    clear: (runHandle: string) => Promise<ClearedDemoOutage | null>;
  };
};

type RequestHeaders = Record<string, string | string[] | undefined>;
type ToolRequestExtra = {
  requestInfo?: {
    headers: RequestHeaders;
  };
};

const cabinSchema = z.enum(["A", "P", "L"]);
const iataSchema = z.string().length(3).transform((value) => value.toUpperCase());
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const isoMonthSchema = z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM");
const uuidSchema = z.string().uuid();
const pnrSchema = z.string().min(1).max(12).transform((value) => value.toUpperCase());

const contactSchema = z.object({
  name: z.string().max(120).optional(),
  email: z.string().email().max(120).optional(),
  phone: z.string().max(40).optional(),
});

const passengerSchema = z.object({
  passengerNo: z.number().int().min(1).max(9),
  givenName: z.string().min(1).max(80),
  familyName: z.string().min(1).max(80),
  loyaltyNo: z.string().max(40).nullable().optional(),
  notes: z.string().max(240).nullable().optional(),
});

const seatAssignmentSchema = z.object({
  passengerNo: z.number().int().min(1).max(9),
  seatId: z.string().max(8).nullable(),
});

const mealAssignmentSchema = z.object({
  passengerNo: z.number().int().min(1).max(9),
  mealId: z.string().min(1).max(40),
});

const cardSchema = z.object({
  cardholder: z.string().min(1).max(120),
  last4: z.string().regex(/^\d{4}$/),
  brand: z.string().max(40).optional(),
});

function jsonToolResult(body: unknown, isError = false): CallToolResult {
  const structuredContent =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { result: body };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return { ok: response.ok, status: response.status };
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, "http://internal");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

function jsonPost(body?: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function sessionHeaders(
  env: Pick<Env, "BOOKING_SESSION_HEADER">,
  sessionId: string,
): Record<string, string> {
  return { [env.BOOKING_SESSION_HEADER]: sessionId };
}

function demoActivationUrl(base: string, token: string): string {
  const url = new URL("/demo/activate", base);
  url.searchParams.set("token", token);
  return url.toString();
}

function getRequestHeader(extra: ToolRequestExtra, name: string): string | undefined {
  const headers = extra.requestInfo?.headers;
  if (!headers) {
    return undefined;
  }

  const exact = headers[name] ?? headers[name.toLowerCase()];
  if (exact) {
    return Array.isArray(exact) ? exact[0] : exact;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

function getSessionHeaders(
  env: Pick<Env, "BOOKING_SESSION_HEADER">,
  extra: ToolRequestExtra,
): Record<string, string> | undefined {
  const sessionId = getRequestHeader(extra, env.BOOKING_SESSION_HEADER);
  return sessionId ? sessionHeaders(env, sessionId) : undefined;
}

async function callInternalApi(
  internalFetch: InternalFetch,
  path: string,
  init?: RequestInit,
): Promise<CallToolResult> {
  const response = await internalFetch(path, init);
  const body = await readResponseBody(response);
  return jsonToolResult(body, !response.ok);
}

export function createBookingMcpServer(options: BookingMcpServerOptions): McpServer {
  const { internalFetch, env, demoOutages } = options;
  const server = new McpServer({
    name: "flylo-booking-backend",
    version: "0.1.0",
  });

  server.registerTool(
    "list_airports",
    {
      title: "List airports",
      description: "List the airport catalog available for booking.",
    },
    async () => callInternalApi(internalFetch, "/v1/airports"),
  );

  server.registerTool(
    "get_airport",
    {
      title: "Get airport",
      description: "Get details for one airport by IATA code.",
      inputSchema: z.object({ iata: iataSchema }),
    },
    async ({ iata }) => callInternalApi(internalFetch, `/v1/airports/${iata}`),
  );

  server.registerTool(
    "list_routes",
    {
      title: "List routes",
      description: "List routes, optionally filtered by origin and destination IATA codes.",
      inputSchema: z.object({
        from: iataSchema.optional(),
        to: iataSchema.optional(),
      }),
    },
    async ({ from, to }) =>
      callInternalApi(internalFetch, withQuery("/v1/routes", { from, to })),
  );

  server.registerTool(
    "search_flights",
    {
      title: "Search flights",
      description: "Search dated flights for a route, passenger count, and optional cabin.",
      inputSchema: z.object({
        from: iataSchema,
        to: iataSchema,
        date: isoDateSchema,
        pax: z.number().int().min(1).max(9).optional(),
        cabin: cabinSchema.optional(),
      }),
    },
    async ({ from, to, date, pax, cabin }, extra) => {
      const headers = getSessionHeaders(env, extra);
      return callInternalApi(
        internalFetch,
        withQuery("/v1/flights/search", { from, to, date, pax, cabin }),
        headers ? { headers } : undefined,
      );
    },
  );

  server.registerTool(
    "get_flight_calendar",
    {
      title: "Get flight calendar",
      description: "Return a month grid of available flight days and starting prices.",
      inputSchema: z.object({
        from: iataSchema,
        to: iataSchema,
        month: isoMonthSchema,
        cabin: cabinSchema.optional(),
      }),
    },
    async ({ from, to, month, cabin }, extra) => {
      const headers = getSessionHeaders(env, extra);
      return callInternalApi(
        internalFetch,
        withQuery("/v1/flights/calendar", { from, to, month, cabin }),
        headers ? { headers } : undefined,
      );
    },
  );

  server.registerTool(
    "get_flight",
    {
      title: "Get flight",
      description: "Get flight details, aircraft information, route details, and cabin fares.",
      inputSchema: z.object({ flightId: uuidSchema }),
    },
    async ({ flightId }, extra) => {
      const headers = getSessionHeaders(env, extra);
      return callInternalApi(
        internalFetch,
        `/v1/flights/${flightId}`,
        headers ? { headers } : undefined,
      );
    },
  );

  server.registerTool(
    "get_seat_map",
    {
      title: "Get seat map",
      description: "Get seat geometry and availability for a flight cabin.",
      inputSchema: z.object({
        flightId: uuidSchema,
        cabin: cabinSchema,
      }),
    },
    async ({ flightId, cabin }) =>
      callInternalApi(
        internalFetch,
        withQuery(`/v1/flights/${flightId}/seat-map`, { cabin }),
      ),
  );

  server.registerTool(
    "get_flight_manifest",
    {
      title: "Get flight manifest",
      description: "Get the staff passenger manifest for a flight.",
      inputSchema: z.object({ flightId: uuidSchema }),
    },
    async ({ flightId }) =>
      callInternalApi(internalFetch, `/v1/flights/${flightId}/manifest`),
  );

  server.registerTool(
    "get_flight_briefing",
    {
      title: "Get flight briefing",
      description: "Get VIP, service-recovery, and special-attention briefing for a flight.",
      inputSchema: z.object({ flightId: uuidSchema }),
    },
    async ({ flightId }) =>
      callInternalApi(internalFetch, `/v1/flights/${flightId}/briefing`),
  );

  server.registerTool(
    "create_booking",
    {
      title: "Create booking",
      description: "Create a draft booking and 10-minute hold for the session.",
      inputSchema: z.object({
        flightId: uuidSchema,
        cabin: cabinSchema,
        pax: z.number().int().min(1).max(9),
        contact: contactSchema.optional(),
      }),
    },
    async ({ flightId, cabin, pax, contact }, extra) =>
      callInternalApi(
        internalFetch,
        "/v1/bookings",
        jsonPost({ flightId, cabin, pax, contact }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "get_booking",
    {
      title: "Get booking",
      description: "Load a booking by PNR using the owner session or matching contact email.",
      inputSchema: z.object({
        pnr: pnrSchema,
        email: z.string().email().optional(),
      }),
    },
    async ({ pnr, email }, extra) => {
      const headers = getSessionHeaders(env, extra);
      return callInternalApi(
        internalFetch,
        withQuery(`/v1/bookings/${pnr}`, { email }),
        headers ? { headers } : undefined,
      );
    },
  );

  server.registerTool(
    "update_booking_contact",
    {
      title: "Update booking contact",
      description: "Save lead-traveller contact details for an owned draft booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
        contact: contactSchema,
      }),
    },
    async ({ pnr, contact }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/contact`,
        jsonPost({ contact }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "update_booking_passengers",
    {
      title: "Update booking passengers",
      description: "Upsert passenger names and metadata for an owned booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
        passengers: z.array(passengerSchema).min(1).max(9),
      }),
    },
    async ({ pnr, passengers }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/passengers`,
        jsonPost({ passengers }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "assign_booking_seats",
    {
      title: "Assign booking seats",
      description: "Hold, change, or clear seat assignments for an owned booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
        assignments: z.array(seatAssignmentSchema).min(1).max(9),
      }),
    },
    async ({ pnr, assignments }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/seats`,
        jsonPost({ assignments }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "assign_booking_meals",
    {
      title: "Assign booking meals",
      description: "Assign meal choices for passengers on an owned booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
        assignments: z.array(mealAssignmentSchema).min(1).max(9),
      }),
    },
    async ({ pnr, assignments }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/meals`,
        jsonPost({ assignments }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "create_payment_intent",
    {
      title: "Create payment intent",
      description: "Create a mock payment intent for an owned booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
      }),
    },
    async ({ pnr }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/payment-intent`,
        jsonPost(undefined, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "confirm_booking",
    {
      title: "Confirm booking",
      description: "Confirm payment, convert held seats, and ticket the booking.",
      inputSchema: z.object({
        pnr: pnrSchema,
        paymentId: uuidSchema,
        card: cardSchema,
      }),
    },
    async ({ pnr, paymentId, card }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/confirm`,
        jsonPost({ paymentId, card }, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancel an owned booking and release/refund associated inventory.",
      inputSchema: z.object({
        pnr: pnrSchema,
      }),
    },
    async ({ pnr }, extra) =>
      callInternalApi(
        internalFetch,
        `/v1/bookings/${pnr}/cancel`,
        jsonPost(undefined, getSessionHeaders(env, extra)),
      ),
  );

  server.registerTool(
    "list_my_trips",
    {
      title: "List my trips",
      description: "List up to 50 bookings owned by the provided browser session.",
      inputSchema: z.object({}),
    },
    async (_args, extra) =>
      callInternalApi(internalFetch, "/v1/me/trips", {
        headers: getSessionHeaders(env, extra),
      }),
  );

  server.registerTool(
    "release_expired_holds",
    {
      title: "Release expired holds",
      description: "Run the same expired-hold sweep used by the scheduled cron endpoint.",
      inputSchema: z.object({}),
    },
    async () => {
      // Cron auth is server-side only. Do not forward the MCP bearer
      // (FLYLO_MCP_TOKEN); that is a different credential from CRON_SECRET.
      const cronSecret = process.env.CRON_SECRET;
      const headers = cronSecret
        ? { Authorization: `Bearer ${cronSecret}` }
        : undefined;
      return callInternalApi(
        internalFetch,
        "/v1/_cron/release-expired-holds",
        jsonPost(undefined, headers),
      );
    },
  );

  server.registerTool(
    "request_marketing_change",
    {
      title: "Request marketing change",
      description:
        "File a marketing-change request (for example a flash-sale banner and a " +
        "percent-off promo code) as a Jira ticket. Returns the created issue key " +
        "and browse URL, or a clear result when Jira is not configured.",
      inputSchema: z.object({
        title: z.string().min(1).max(240),
        description: z.string().min(1).max(4000),
        promoCode: z.string().max(40).optional(),
        discountPercent: z.number().gt(0).max(100).optional(),
        startsAt: isoDateSchema.optional(),
        endsAt: isoDateSchema.optional(),
      }),
    },
    async (input) => {
      if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
        return jsonToolResult(
          {
            ok: false,
            code: "invalid_dates",
            message: "endsAt must be on or after startsAt.",
          },
          true,
        );
      }
      const result = await createMarketingIssue(input, env);
      const isError = !result.configured || Boolean(result.error);
      return jsonToolResult(result, isError);
    },
  );

  const runHandleSchema = z
    .string()
    .min(20)
    .max(200)
    .describe("Opaque run handle returned once by prepare_demo_outage.");

  server.registerTool(
    "prepare_demo_outage",
    {
      title: "Prepare scoped demo outage",
      description:
        "Create a per-browser FlyLo booking outage and return an activation " +
        "URL plus a one-time runHandle. Opening the URL binds the browser " +
        "only. Pricing stays healthy until trigger_demo_outage.",
      inputSchema: z.object({
        ttlMinutes: z.number().int().min(1).max(60).optional(),
        slackChannel: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            "Slack channel name or channel ID where FlyLo Ops should post this run.",
          )
          .optional(),
      }),
    },
    async (args) => {
      const outage = await demoOutages.prepare({
        ...(args.ttlMinutes === undefined ? {} : { ttlMinutes: args.ttlMinutes }),
        ...(args.slackChannel === undefined
          ? {}
          : { slackChannel: args.slackChannel }),
      });
      const activationUrl = demoActivationUrl(
        env.DEMO_BOOKING_WEB_URL,
        outage.activationToken,
      );

      return jsonToolResult({
        ok: true,
        demoSessionId: outage.demoSessionId,
        runHandle: outage.runHandle,
        scope: "browser-session",
        activationUrl,
        ttlMinutes: outage.ttlMinutes,
        expiresAt: outage.expiresAt,
        ...(args.slackChannel === undefined
          ? {}
          : { slackChannel: args.slackChannel }),
        instructions:
          "Open activationUrl in the presenter's browser to BIND this outage. " +
          "The browser stays healthy until you call trigger_demo_outage with " +
          "runHandle. runHandle is shown only once; keep it. demoSessionId is " +
          "for attribution only. Call clear_demo_outage with runHandle to " +
          "recover.",
      });
    },
  );

  server.registerTool(
    "trigger_demo_outage",
    {
      title: "Trigger scoped demo outage",
      description:
        "Arm a previously bound scoped demo outage so pricing fails for that " +
        "browser only. Fails if the activation URL has not been opened.",
      inputSchema: z.object({
        runHandle: runHandleSchema,
      }),
    },
    async ({ runHandle }) => {
      try {
        const outage = await demoOutages.trigger(runHandle);
        return jsonToolResult({
          ok: true,
          demoSessionId: outage.demoSessionId,
          bookingSessionId: outage.bookingSessionId,
          expiresAt: outage.expiresAt,
          message:
            "The scoped demo outage is active. Pricing requests from that " +
            "browser fail until clear_demo_outage.",
        });
      } catch (error) {
        if (error instanceof DemoOutageTriggerError) {
          return jsonToolResult(
            {
              ok: false,
              code: error.code,
              message: error.message,
            },
            true,
          );
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "clear_demo_outage",
    {
      title: "Clear scoped demo outage",
      description:
        "Clear one browser-scoped FlyLo outage. Other presenters and the " +
        "global outage flag are untouched.",
      inputSchema: z.object({
        runHandle: runHandleSchema,
      }),
    },
    async ({ runHandle }) => {
      const cleared = await demoOutages.clear(runHandle);
      return jsonToolResult(
        cleared
          ? {
              ok: true,
              demoSessionId: cleared.demoSessionId,
              cleared: true,
              message:
                "The scoped demo outage is cleared. The browser is healthy again.",
            }
          : {
              ok: false,
              cleared: false,
              message:
                "No pending or active scoped demo outage matched that run handle.",
            },
        !cleared,
      );
    },
  );

  return server;
}
