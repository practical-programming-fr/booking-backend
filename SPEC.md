# FlyLo Booking · Backend Spec

A small HTTP API on top of Supabase Postgres that powers the FlyLo booking
flow (search → detail → checkout → trip management).

## Why a separate service

Supabase + RLS handles read-side queries from the browser fine, but the
booking flow has logic that doesn't sit comfortably in policy SQL:

- 10-minute seat holds that expire on a timer
- Atomic "hold → pay → ticket → release" transitions
- PNR generation and validation
- Mock payment orchestration

So we keep the privileged operations behind a typed HTTP surface. The
frontend talks to Supabase directly only for things that are safe under
RLS (none in v1 — we may use it for realtime seat updates later).

## Stack

- **Hono** on Node, deployable as a single Vercel Function
- **TypeScript** + **Zod** for request validation
- **Drizzle** (query builder) over **postgres-js** against the Supabase
  pooled connection
- Hand-written **SQL migrations** in `supabase/migrations/` applied by a
  small runner script (`npm run db:migrate`)
- **Vitest** for tests

## Environment

All read from `process.env`; see `.env.example`.

| Var | Used by |
|---|---|
| `SUPABASE_URL` | supabase-js client (auth lookups) |
| `SUPABASE_ANON_KEY` | supabase-js client |
| `SUPABASE_SERVICE_ROLE_KEY` | privileged supabase-js client |
| `SUPABASE_DB_URL` | Drizzle (postgres-js) — Transaction pooler URL |
| `BOOKING_SESSION_HEADER` | header name for browser session id (default `x-booking-session`) |
| `BOOKING_ALLOWED_ORIGINS` | comma-separated CORS allowlist |
| `PORT` | local dev server port (default `8787`) |
| `JIRA_BASE_URL` | optional; Jira Cloud site URL for `request_marketing_change` |
| `JIRA_EMAIL` | optional; Atlassian account email (Basic auth) |
| `JIRA_API_TOKEN` | optional; Atlassian API token (Basic auth), secret |
| `JIRA_PROJECT_KEY` | optional; project key marketing tickets are filed into |
| `OPS_AGENT_TOKEN` | optional; bearer token gating the `/v1/ops` disruption endpoints for the FlyLo Ops Agent service principal |

The `JIRA_*` vars are all optional. The `request_marketing_change` MCP tool
uses them to file a Jira ticket; when any is unset the tool degrades
gracefully and reports that Jira is not configured. Provide them as platform
secrets; never commit them.

## Data model

See `supabase/migrations/<timestamp>_initial_schema.sql` for the source
of truth. Summary:

| Table | Purpose |
|---|---|
| `airports` | IATA-keyed catalog with city/country/continent and lat/lon |
| `aircraft_types` | Fleet types with seats, range, cruise, role |
| `cabins` | A/P/L definitions + price multiplier + dining notes |
| `seat_map_templates` | Geometry per `(aircraft_type, cabin)` |
| `meals` | Catalog of dining options + applicable cabins |
| `routes` | `from_iata` → `to_iata` pairs with baseline economics |
| `flights` | Concrete dated departures (one row per flight number per day) |
| `flight_fares` | Per-flight × cabin pricing + remaining availability |
| `flight_seats` | One row per seat on each flight with status |
| `seat_holds` | 10-minute soft locks tied to a browser session |
| `bookings` | The PNR / order, linked to a session and (optionally) a user; carries `promo_code` + `discount_eur` for the applied promo |
| `booking_segments` | Legs of a booking (v1: always one) |
| `passengers` | Travelers on a booking + assigned seat, meal, loyalty tier, and service tags |
| `payments` | Mock charge records |
| `booking_events` | Operational timeline for rebooking, disruption, and service notes |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | liveness |
| `GET` | `/v1/airports` | full catalog |
| `GET` | `/v1/routes` | optionally filtered by `?from` |
| `GET` | `/v1/flights/search` | `?from&to&date&pax&cabin` — Airbnb-style results |
| `GET` | `/v1/flights/calendar` | `?from&to&month` — price-per-day grid |
| `GET` | `/v1/flights/:id` | flight detail with cabin summary |
| `GET` | `/v1/flights/:id/seat-map` | `?cabin=A` seat geometry + availability |
| `GET` | `/v1/flights/:id/manifest` | staff/agent passenger manifest |
| `GET` | `/v1/flights/:id/briefing` | VIP, service-recovery, and special-attention summary |
| `POST` | `/v1/bookings` | create draft booking (returns `pnr`) |
| `POST` | `/v1/bookings/:pnr/passengers` | upsert passenger list |
| `POST` | `/v1/bookings/:pnr/seats` | hold seats |
| `POST` | `/v1/bookings/:pnr/meals` | assign meals |
| `POST` | `/v1/bookings/:pnr/promo` | apply or clear a promo code; recomputes totals |
| `DELETE` | `/v1/bookings/:pnr/promo` | clear an applied promo, restore full price |
| `POST` | `/v1/bookings/:pnr/payment-intent` | mock provider |
| `POST` | `/v1/bookings/:pnr/confirm` | issue tickets, release holds |
| `GET` | `/v1/bookings/:pnr` | guest retrieval — requires `?email=…` or session header |
| `POST` | `/v1/bookings/:pnr/cancel` | cancel |
| `GET` | `/v1/me/trips` | list bookings for current session |

A scheduled task (Vercel Cron, configured in `vercel.json`) hits
`POST /v1/_cron/release-expired-holds` every minute.

### Ops disruption / recovery (FlyLo Ops Agent)

The `/v1/ops` endpoints are agent-shaped operational tools for airline
disruption and recovery. They are distinct from the `/v1/_ops` incident
console. Auth is a service principal: when `OPS_AGENT_TOKEN` is set every
request must send `Authorization: Bearer <OPS_AGENT_TOKEN>`; when it is unset
the endpoints are open in local dev but return 503 in production. The existing
`x-booking-session` browser identity is unchanged and additional.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/ops/flights/:flightNo/passengers` | booked passengers on a flight, with contact + onward-connection info |
| `POST` | `/v1/ops/flights/:flightNo/cancel` | mark a flight cancelled and return the affected fan-out (idempotent) |
| `GET` | `/v1/ops/flights/:flightNo/alternatives` | candidate rebooking flights (same route, near-term, per-cabin availability + fare delta) |
| `POST` | `/v1/ops/rebook` | move a booking segment onto a new flight, keyed on `(pnr, fromSegmentId, toFlightId)` (idempotent) |

Flight selectors accept `?departDate=YYYY-MM-DD` or `?flightId=` to disambiguate
a flight number that runs on more than one day; without them the soonest
upcoming departure wins. Writes go through the booking domain (seat status,
fare counters, totals recompute) and record `booking_events` for auditability.
Rebookings are additionally recorded in `ops_rebookings` as the idempotency
ledger.

## Browser session identity

Without auth, every request from the frontend carries a header
`x-booking-session: <uuid>`. Bookings are owned by the session that
created them; the same UUID is stored in `localStorage` on the frontend.
The guest retrieval endpoint (`GET /v1/bookings/:pnr?email=…`) lets a
user recover a trip on a different device.

When we add real auth later, the session header is replaced by a
Supabase access token and `bookings.user_id` becomes the owner — the
schema already has both columns.

## Build & run

```bash
npm install
npm run db:migrate    # apply SQL migrations
npm run db:seed       # populate rolling catalog, flights, bookings, manifests
npm run dev           # http://localhost:8787
npm run build
npm test
```

### Reset story

- `npm run db:reseed` — wipe data, regenerate demo inventory/bookings (most common).
- `npm run db:reset`  — drop the schema, re-apply migrations, re-seed.
- `npm run db:wipe`   — truncate everything, leave the schema in place.

### Realistic inventory

The seed feels like a real timetable, not a uniform grid:

- Each route has a stable, varied departure-time pattern (no two routes
  use the same slots, but the same route uses the same slots every day).
- Prices modulate by day-of-week (weekend +18%, Tue/Wed −8%) and by
  advance-purchase (≤7d +32%, ≤20d +12%, ≥50d −12%) on top of per-flight
  jitter.
- Seats are partially pre-taken — Atlas Suite around 50–75%, Linen
  20–45%, with rates rising as departure approaches. All deterministic
  so the seed reproduces exactly.
- Flight numbers are stable per (route, slot) so the same route always
  appears as e.g. FL 318 morning + FL 320 evening.
- `SEED_BASE_DATE=YYYY-MM-DD` can pin the rolling baseline; otherwise the
  seed starts from today's UTC date.
- Named demo bookings use stable PNRs (`VIP001`, `BIZ001`, `FAM001`,
  `RBK001`, `RBKOLD`, `HLD001`) and include VIP, business, family,
  rebooking/service-recovery, cancelled, and awaiting-payment scenarios.
- Selected showcase cabins are normalized so named passengers, seat-map
  status, manifest rows, and fare availability match.

## Deployment

Vercel. The `api/index.ts` adapter wraps the Hono app, and
`vercel.json` declares one cron schedule. Environment variables are
configured in the Vercel project settings (matching the names above).
