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
| `bookings` | The PNR / order, linked to a session and (optionally) a user |
| `booking_segments` | Legs of a booking (v1: always one) |
| `passengers` | Travelers on a booking + assigned seat + meal |
| `payments` | Mock charge records |

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
| `POST` | `/v1/bookings` | create draft booking (returns `pnr`) |
| `POST` | `/v1/bookings/:pnr/passengers` | upsert passenger list |
| `POST` | `/v1/bookings/:pnr/seats` | hold seats |
| `POST` | `/v1/bookings/:pnr/meals` | assign meals |
| `POST` | `/v1/bookings/:pnr/payment-intent` | mock provider |
| `POST` | `/v1/bookings/:pnr/confirm` | issue tickets, release holds |
| `GET` | `/v1/bookings/:pnr` | guest retrieval — requires `?email=…` or session header |
| `POST` | `/v1/bookings/:pnr/cancel` | cancel |
| `GET` | `/v1/me/trips` | list bookings for current session |

A scheduled task (Vercel Cron, configured in `vercel.json`) hits
`POST /v1/_cron/release-expired-holds` every minute.

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
npm run db:seed       # populate catalog + 90 days of flights
npm run dev           # http://localhost:8787
npm run build
npm test
```

## Deployment

Vercel. The `api/index.ts` adapter wraps the Hono app, and
`vercel.json` declares one cron schedule. Environment variables are
configured in the Vercel project settings (matching the names above).
