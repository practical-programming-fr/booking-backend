# FlyLo Booking · Backend

A small Hono + TypeScript service on top of Supabase Postgres that powers
the FlyLo booking flow. Designed to deploy as a single Vercel Function.

See [`SPEC.md`](./SPEC.md) for the data model, endpoint inventory, and
environment contract.

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
| `npm run db:seed` | Upsert catalog + regenerate next 30 days of flight inventory |
| `npm run db:reset` | Drop the public schema, re-apply migrations, re-seed |

## Layout

```
api/index.ts                    Vercel Function entry (wraps the Hono app)
src/app.ts                      Hono app + middleware + route mounting
src/server.ts                   Local dev entry (Node @hono/node-server)
src/env.ts                      Zod-validated env loader
src/db/                         Drizzle schema + postgres-js client
src/lib/                        Pricing, PNR, seat helpers
src/data/                       Static catalog (airports, aircraft, cabins, meals, routes, seats)
src/routes/                     One file per resource (health, airports, routes, flights, …)
supabase/migrations/            Hand-written SQL — source of truth for the schema
supabase/config.toml            Local Supabase CLI config (optional)
scripts/migrate.ts              Apply SQL migrations
scripts/seed.ts                 Run the seed pipeline
tests/                          Vitest unit tests
vercel.json                     Vercel rewrites + cron schedules
```

## Endpoints (v0.1)

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

Write-side endpoints (bookings, holds, payments, confirm) land in the
next PR.

## Deployment

This service is intended to deploy as a single Vercel Function:

1. `vercel link` the repo to a Vercel project.
2. Add the same `SUPABASE_*` env vars as in `.env.example` to the Vercel
   project's Production and Preview environments.
3. `vercel deploy --prod` (or push to `main` if you've wired up the GH
   integration).

`vercel.json` declares a once-per-minute cron that pings
`/v1/_cron/release-expired-holds` (endpoint lands with the booking-write
PR).
