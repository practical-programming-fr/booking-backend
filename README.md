# FlyLo Booking · Backend

A small Hono + TypeScript service on top of Supabase Postgres that powers
the FlyLo booking flow. Designed to deploy as a single Vercel Function.

> Part of **FlyLo**. Get access and see all apps + scenarios at the FlyLo hub: https://flylo-provisioning.internalsphere.com (contributing: read `.cursor/rules/` in the flylo-provisioning repo).

See [`SPEC.md`](./SPEC.md) for the data model, endpoint inventory, and
environment contract. See [`docs/mcp.md`](./docs/mcp.md) for the MCP server
tool inventory and usage guide.

## Quick start

```bash
cp .env.example .env
# fill in SUPABASE_* values from your project
npm install
npm run db:migrate
npm run db:seed
npm run dev
# → http://localhost:8787/v1/health
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local server with file watch on port 8787 |
| `npm run build` | Type-check the project (no JS emitted; Vercel handles the actual build) |
| `npm test` | Run vitest unit tests |
| `npm run db:migrate` | Apply pending SQL migrations from `supabase/migrations/` |
| `npm run db:seed` | Upsert catalog + regenerate rolling demo data |
| `npm run db:wipe` | `truncate … restart identity cascade` every table, keeps schema |
| `npm run db:reseed` | `db:wipe` then `db:seed` (data refresh, no schema change) |
| `npm run db:reset` | Drop the `public` schema entirely, re-apply migrations, re-seed |

### Picking the right reset

- **Schema is fine, want fresh data** → `npm run db:reseed`
- **Schema has changed and you want a clean slate** → `npm run db:reset`
- **Just delete everything without re-seeding** → `npm run db:wipe`

`db:seed` itself is idempotent and safe to re-run on its own — it
upserts catalog rows, replaces future inventory, and recreates demo
bookings/manifests.

### Seed horizon

`SEED_DAYS=45` by default. Override per-run: `SEED_DAYS=90 npm run db:seed`.

The seed baseline defaults to today's UTC date. Override it for a
reproducible demo snapshot:

```bash
SEED_BASE_DATE=2026-06-01 SEED_DAYS=45 npm run db:seed
```

The seed generates ~4.8k flights and ~220k seat rows for 45 days against
the full catalog (17 airports — LHR + SFO as hubs, CDG + AMS as
secondary origins, 13 further destinations; 55 routes). Expect 30-60s
on a healthy connection — the script batches per-day inserts so it
doesn't paginate one row at a time.

The seed also creates named demo bookings with stable PNRs such as
`VIP001`, `BIZ001`, `FAM001`, `RBK001`, `RBKOLD`, and `HLD001`. These
cover VIP, corporate, family, service-recovery/rebooked, cancelled, and
awaiting-payment scenarios. Selected showcase cabins are normalized so
seat maps, fares, manifests, and named passengers agree.

## Layout

```
app.ts                          Vercel Hono entrypoint (exports the app)
src/app.ts                      Hono app + middleware + route mounting
src/server.ts                   Local dev entry (Node @hono/node-server)
src/env.ts                      Zod-validated env loader
src/db/                         Drizzle schema + postgres-js client
src/lib/                        Pricing, PNR, inventory generation helpers
src/data/                       Static catalog (airports, aircraft, cabins, meals, routes, seats)
src/domain/                     Booking lifecycle (loader, totals, booking, seats, payments, cron)
src/routes/                     One file per resource (health, airports, routes, flights, bookings, me, cron)
supabase/migrations/            Hand-written SQL — source of truth for the schema
supabase/config.toml            Local Supabase CLI config (optional)
scripts/migrate.ts              Apply SQL migrations; --reset drops the schema first
scripts/seed.ts                 CLI wrapper for reusable seed pipeline
scripts/wipe.ts                 Truncate every table without touching the schema
tests/                          Vitest unit tests
vercel.json                     Vercel rewrites + cron schedules
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/health` | Includes a DB ping |
| `GET` | `/v1/airports` | Catalog |
| `GET` | `/v1/airports/:iata` | Detail |
| `GET` | `/v1/routes?from=&to=` | Catalog of routes |
| `GET` | `/v1/flights/search?from&to&date&pax&cabin` | Date-specific results |
| `GET` | `/v1/flights/calendar?from&to&month&cabin` | Month-grid of price-per-day |
| `GET` | `/v1/flights/:id` | Detail incl. per-cabin fares |
| `GET` | `/v1/flights/:id/seat-map?cabin=A` | Seat geometry + availability |
| `GET` | `/v1/flights/:id/manifest` | Staff/agent passenger manifest for confirmed + held bookings |
| `GET` | `/v1/flights/:id/briefing` | Aggregated VIP, service-recovery, and special-attention briefing |
| `POST` | `/v1/bookings` | Create draft (returns PNR + 10-min hold window) |
| `GET` | `/v1/bookings/:pnr` | Owner via session, or guest with `?email=` |
| `POST` | `/v1/bookings/:pnr/contact` | Save lead-traveller contact |
| `POST` | `/v1/bookings/:pnr/passengers` | Upsert passenger list |
| `POST` | `/v1/bookings/:pnr/seats` | Hold or clear seat assignments |
| `POST` | `/v1/bookings/:pnr/meals` | Assign dining plans |
| `POST` | `/v1/bookings/:pnr/payment-intent` | Mock payment intent + status flip |
| `POST` | `/v1/bookings/:pnr/confirm` | Pay → ticket → status=confirmed |
| `POST` | `/v1/bookings/:pnr/cancel` | Cancel + release seats / refund |
| `GET` | `/v1/me/trips` | List bookings for this browser session |
| `POST` / `GET` | `/v1/_cron/release-expired-holds` | Sweep expired holds; auth via `CRON_SECRET` |
| `POST` | `/mcp` | MCP Streamable HTTP endpoint exposing the booking backend as tools |

Every authenticated booking endpoint requires an `x-booking-session: <uuid>`
header. The frontend keeps that UUID in `localStorage` per browser so
bookings persist without auth.

## MCP endpoint

`POST /mcp` exposes the booking backend through the stable v1
`@modelcontextprotocol/sdk` Streamable HTTP transport. The server runs in
stateless JSON-response mode so each request can be handled by any Vercel
Function instance. Long-lived GET SSE sessions and stateful DELETE cleanup
are not used by this deployment mode.

The MCP tools mirror the `/v1` HTTP API:

- catalog and shopping: `list_airports`, `get_airport`, `list_routes`,
  `search_flights`, `get_flight_calendar`, `get_flight`, `get_seat_map`,
  `get_flight_manifest`, `get_flight_briefing`
- booking lifecycle: `create_booking`, `get_booking`,
  `update_booking_contact`, `update_booking_passengers`,
  `assign_booking_seats`, `assign_booking_meals`, `create_payment_intent`,
  `confirm_booking`, `cancel_booking`, `list_my_trips`
- maintenance: `release_expired_holds`

Tools that operate on owned bookings forward the same
`x-booking-session: <uuid>` HTTP header sent to `/mcp`; the session UUID is
not a tool argument. `get_booking` can instead use `email` for the same
guest retrieval flow as `/v1/bookings/:pnr?email=...`. If `CRON_SECRET` is
configured, call `release_expired_holds` with the matching
`Authorization: Bearer <secret>` HTTP header on the `/mcp` request.

For the full tool inventory, argument schemas, header requirements,
JSON-RPC examples, and implementation map, see [`docs/mcp.md`](./docs/mcp.md).

## Deployment

This service is intended to deploy as a single Vercel Function:

1. `vercel link` the repo to a Vercel project.
2. Add the same `SUPABASE_*` env vars as in `.env.example` to the Vercel
   project's Production and Preview environments.
3. `vercel deploy --prod` (or push to `main` if you've wired up the GH
   integration).

Vercel should use the **Hono** framework preset. The root `app.ts` imports
`hono` and exports the Hono app for production; `src/server.ts` is only for
local `npm run dev`.

`vercel.json` declares a once-per-minute cron that pings
`/v1/_cron/release-expired-holds` (endpoint lands with the booking-write
PR).
