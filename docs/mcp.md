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

## Implementation map

- Route mount: `src/app.ts`
- MCP HTTP route: `src/routes/mcp.ts`
- Tool registration and internal `/v1` forwarding: `src/mcp/server.ts`
- Route/tool-call tests: `tests/mcp-routes.test.ts`
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
