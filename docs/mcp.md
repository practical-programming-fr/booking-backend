# FlyLo Booking MCP Server

This app exposes the booking backend as a Model Context Protocol (MCP)
server at `POST /mcp`.

The endpoint is intended for agents and MCP clients that need the same
capabilities as the `/v1` HTTP API: catalog lookup, flight shopping, seat
maps, booking lifecycle operations, trip lookup, staff flight context, and
the expired-hold maintenance sweep.

## Runtime and SDK

- SDK package: `@modelcontextprotocol/sdk` on the stable v1 line.
- Transport: Streamable HTTP via
  `WebStandardStreamableHTTPServerTransport`.
- Deployment mode: stateless JSON response mode.
- Route: top-level `POST /mcp`, mounted outside `/v1`.

This deployment does not use long-lived GET SSE streams or stateful DELETE
cleanup. Each MCP request creates a fresh stateless MCP server/transport
pair and can be handled by any Vercel Function instance.

## Required MCP HTTP headers

MCP Streamable HTTP POST requests must include:

```http
Content-Type: application/json
Accept: application/json, text/event-stream
```

The SDK will return protocol-level 4xx JSON-RPC errors before tool
execution if these transport headers are missing or invalid.

## Booking session and protected headers

Do not pass protected credentials as tool arguments.

Owned booking tools use the same browser session header as the HTTP API:

```http
x-booking-session: 11111111-1111-4111-8111-111111111111
```

The header name is configurable with `BOOKING_SESSION_HEADER`; the default
is `x-booking-session`. The MCP implementation forwards that incoming
header to the internal `/v1` route call.

The maintenance sweep forwards the incoming `Authorization` header:

```http
Authorization: Bearer <CRON_SECRET>
```

If `CRON_SECRET` is unset, the underlying cron route remains open, matching
the existing local-development behavior. If `CRON_SECRET` is set and the
header is missing or wrong, the tool returns the same error body as
`/v1/_cron/release-expired-holds`.

## Tool response shape

Each tool calls a fixed internal `/v1` endpoint and returns the endpoint
JSON in both MCP content forms:

- `structuredContent`: the parsed JSON object from the `/v1` response.
- `content[0].text`: pretty-printed JSON for clients that display text.

If the internal `/v1` response is non-2xx, the MCP tool result has
`isError: true` and preserves the backend error body.

`request_marketing_change` is the one tool that does not call an internal
`/v1` endpoint; it talks to Jira Cloud directly (see the Marketing section
below) but returns the same `structuredContent` + text shape.

## Tool inventory

### Catalog and shopping

| Tool | Required arguments | Optional arguments | Internal endpoint |
|---|---|---|---|
| `list_airports` | none | none | `GET /v1/airports` |
| `get_airport` | `iata` | none | `GET /v1/airports/:iata` |
| `list_routes` | none | `from`, `to` | `GET /v1/routes?from=&to=` |
| `search_flights` | `from`, `to`, `date` | `pax`, `cabin` | `GET /v1/flights/search?from&to&date&pax&cabin` |
| `get_flight_calendar` | `from`, `to`, `month` | `cabin` | `GET /v1/flights/calendar?from&to&month&cabin` |
| `get_flight` | `flightId` | none | `GET /v1/flights/:id` |
| `get_seat_map` | `flightId`, `cabin` | none | `GET /v1/flights/:id/seat-map?cabin=` |
| `get_flight_manifest` | `flightId` | none | `GET /v1/flights/:id/manifest` |
| `get_flight_briefing` | `flightId` | none | `GET /v1/flights/:id/briefing` |

### Booking lifecycle

These tools require the `x-booking-session` HTTP header unless noted.

| Tool | Required arguments | Optional arguments | Internal endpoint |
|---|---|---|---|
| `create_booking` | `flightId`, `cabin`, `pax` | `contact` | `POST /v1/bookings` |
| `get_booking` | `pnr` | `email` | `GET /v1/bookings/:pnr?email=` |
| `update_booking_contact` | `pnr`, `contact` | none | `POST /v1/bookings/:pnr/contact` |
| `update_booking_passengers` | `pnr`, `passengers` | none | `POST /v1/bookings/:pnr/passengers` |
| `assign_booking_seats` | `pnr`, `assignments` | none | `POST /v1/bookings/:pnr/seats` |
| `assign_booking_meals` | `pnr`, `assignments` | none | `POST /v1/bookings/:pnr/meals` |
| `create_payment_intent` | `pnr` | none | `POST /v1/bookings/:pnr/payment-intent` |
| `confirm_booking` | `pnr`, `paymentId`, `card` | none | `POST /v1/bookings/:pnr/confirm` |
| `cancel_booking` | `pnr` | none | `POST /v1/bookings/:pnr/cancel` |
| `list_my_trips` | none | none | `GET /v1/me/trips` |

`get_booking` can use either the owner session header or a matching
`email` argument for guest retrieval, matching `/v1/bookings/:pnr`.

### Maintenance

| Tool | Required arguments | Optional arguments | Internal endpoint |
|---|---|---|---|
| `release_expired_holds` | none | none | `POST /v1/_cron/release-expired-holds` |

If `CRON_SECRET` is configured, call this tool with the MCP HTTP
`Authorization: Bearer <CRON_SECRET>` header.

### Marketing

| Tool | Required arguments | Optional arguments | Backend |
|---|---|---|---|
| `request_marketing_change` | `title`, `description` | `promoCode`, `discountPercent`, `startsAt`, `endsAt` | Jira Cloud REST API |

### Scoped demo outage

| Tool | Required arguments | Optional arguments | Internal endpoint |
|---|---|---|---|
| `prepare_demo_outage` | none | `ttlMinutes`, `slackChannel` | `public.ops_demo_outages` |
| `start_demo_outage` | none | same as prepare | Alias for `prepare_demo_outage` |
| `trigger_demo_outage` | `demoSessionId` | none | `public.ops_demo_outages` |
| `clear_demo_outage` | `demoSessionId` | none | `public.ops_demo_outages` |

`prepare_demo_outage` creates a pending browser-scoped outage and returns a
`demoSessionId`, expiry, and one-time `activationUrl`. Opening that URL binds
the pending row to the browser's `x-booking-session`. Binding does not activate
the outage. Pricing stays healthy until `trigger_demo_outage` changes the row
from `pending` to `active`.

`start_demo_outage` is a compatibility alias for prepare. It no longer starts
pricing failures immediately.

`trigger_demo_outage` requires a bound pending row. It returns
`outage_not_bound` if the activation URL has not been opened. Once triggered,
pricing requests from the bound browser fail while other browsers remain
healthy.

`clear_demo_outage` clears only the named pending or active outage. The global
`fare_adjustment_v2` flag and other presenters remain unchanged. The default
TTL is 20 minutes and the maximum is 60 minutes.

Both tools run server-side inside booking-backend. When `OPS_SHARED_SECRET` is
configured they inject the `Authorization: Bearer <OPS_SHARED_SECRET>` header
themselves when calling the internal `/v1/_ops` routes, so the calling agent
never handles the ops secret and the secret is never returned in a tool
response. The public booking and crew origins used to build the links come from
`DEMO_BOOKING_WEB_URL` and `DEMO_CREW_WEB_URL` (defaulting to the FlyLo demo
domains). Multiple presenters can each hold their own active session at once;
only their bound browser session 500s. The existing `x-demo-session` path stays
available to the Ops Console and crew NOC.

`request_marketing_change` files a marketing-request ticket into Jira. It
does not call an internal `/v1` endpoint; instead it uses the Jira client in
`src/lib/jira.ts`. Jira Cloud requires the issue description in Atlassian
Document Format (ADF), so the tool builds a minimal ADF document from the
`description` plus any supplied promo details and POSTs to
`{JIRA_BASE_URL}/rest/api/3/issue` with a Basic auth header.

On success the tool result includes `configured: true`, the created issue
`key`, and a `url` of the form `{JIRA_BASE_URL}/browse/{key}`. When Jira is
not fully configured the tool does not throw: it returns `configured: false`
with an explanatory `error` and `isError: true`, so local dev and the build
work without credentials.

The tool reads four optional env vars: `JIRA_BASE_URL`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY`. All are optional; when any is
unset the tool reports that Jira is not configured. Provide them as platform
secrets; never commit them. See `.env.example` and `SPEC.md`.

## Argument reference

Common scalar constraints:

- `iata`: three-letter airport code; normalized to uppercase.
- `cabin`: one of `A`, `P`, `L`.
- `date`: `YYYY-MM-DD`.
- `month`: `YYYY-MM`.
- `flightId`: UUID.
- `pnr`: string, normalized to uppercase.
- `pax`: integer from 1 through 9.

Structured booking arguments:

```ts
type Contact = {
  name?: string;
  email?: string;
  phone?: string;
};

type Passenger = {
  passengerNo: number;
  givenName: string;
  familyName: string;
  loyaltyNo?: string | null;
  notes?: string | null;
};

type SeatAssignment = {
  passengerNo: number;
  seatId: string | null;
};

type MealAssignment = {
  passengerNo: number;
  mealId: string;
};

type Card = {
  cardholder: string;
  last4: string;
  brand?: string;
};
```

## Raw JSON-RPC examples

### Initialize

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "example-agent", "version": "0.0.0" }
    }
  }'
```

### List tools

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

### Search flights

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_flights",
      "arguments": {
        "from": "LHR",
        "to": "SFO",
        "date": "2026-06-15",
        "pax": 2,
        "cabin": "P"
      }
    }
  }'
```

### Create a booking with session ownership

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'x-booking-session: 11111111-1111-4111-8111-111111111111' \
  --data '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "create_booking",
      "arguments": {
        "flightId": "00000000-0000-4000-8000-000000000000",
        "cabin": "L",
        "pax": 1,
        "contact": {
          "email": "guest@example.com"
        }
      }
    }
  }'
```

### List trips for a session

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'x-booking-session: 11111111-1111-4111-8111-111111111111' \
  --data '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "list_my_trips",
      "arguments": {}
    }
  }'
```

### Sweep expired holds

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer dev-cron-secret' \
  --data '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "release_expired_holds",
      "arguments": {}
    }
  }'
```

### Request a marketing change

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "request_marketing_change",
      "arguments": {
        "title": "Flash-sale banner + FLASH20",
        "description": "Add a weekend flash-sale banner and a 20 percent off code.",
        "promoCode": "FLASH20",
        "discountPercent": 20,
        "startsAt": "2026-07-11",
        "endsAt": "2026-07-13"
      }
    }
  }'
```

### Prepare a scoped demo outage

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 8,
    "method": "tools/call",
    "params": {
      "name": "prepare_demo_outage",
      "arguments": {
        "slackChannel": "#incident-talal",
        "ttlMinutes": 20
      }
    }
  }'
```

The result includes a `demoSessionId`, one-time `activationUrl`, and TTL. Open
`activationUrl` in the presenter browser. The browser is bound but remains
healthy.

### Trigger a scoped demo outage

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 9,
    "method": "tools/call",
    "params": {
      "name": "trigger_demo_outage",
      "arguments": {
        "demoSessionId": "<demoSessionId from prepare_demo_outage>"
      }
    }
  }'
```

Trigger changes the bound row from `pending` to `active`. Pricing requests from
that browser now fail.

### Clear a scoped demo outage

```bash
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 10,
    "method": "tools/call",
    "params": {
      "name": "clear_demo_outage",
      "arguments": {
        "demoSessionId": "<demoSessionId from prepare_demo_outage>"
      }
    }
  }'
```

## Implementation map

- Route mount: `src/app.ts`
- MCP HTTP route: `src/routes/mcp.ts`
- Tool registration and internal `/v1` forwarding: `src/mcp/server.ts`
- Activation route: `src/routes/demo.ts`
- Outage lifecycle and activation-token hashing: `src/domain/demo-outage.ts`
- Pricing request guard: `src/domain/ops.ts`
- Browser-scoped outage migrations:
  `supabase/migrations/20260801140000_ops_demo_outages.sql` and
  `supabase/migrations/20260801150000_ops_demo_outages_bound_session_idx.sql`
- Jira client for `request_marketing_change`: `src/lib/jira.ts`
- Route/tool-call tests: `tests/mcp-routes.test.ts`
- Activation and scoped-session tests: `tests/demo-activation-routes.test.ts`,
  `tests/demo-sessions.test.ts`
- Jira client tests: `tests/jira.test.ts`
- Existing backend API routes: `src/routes/*.ts`

When adding or changing `/v1` capabilities, keep `src/mcp/server.ts`, this
document, and `README.md` in sync.

## Testing

Run:

```bash
npm run build
npm test
```

The MCP tests cover:

- `initialize` without database access.
- `tools/list` inventory and protected schema fields.
- transport header validation.
- tool-call forwarding of `x-booking-session`.
- tool-call forwarding of `Authorization` for the maintenance sweep.
- `prepare_demo_outage`, its `start_demo_outage` alias,
  `trigger_demo_outage`, and `clear_demo_outage`.
- Bind-only activation, trigger-before-bind rejection, active-state pricing,
  and scoped recovery.
- `request_marketing_change` graceful degradation when Jira is not
  configured. The Jira client itself (ADF body shape, Basic auth header, and
  the not-configured path) is unit-tested with `fetch` mocked in
  `tests/jira.test.ts`.
