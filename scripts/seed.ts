// Seed script. Idempotent — safe to re-run.
//
// 1. Upserts catalog tables (airports, aircraft_types, cabins, meals,
//    seat_map_templates, routes).
// 2. Wipes any existing future flights (and their fares/seats) and
//    regenerates 30 days of flights starting today, with per-flight
//    seats and fares derived from the templates + route economics.
//
// Run via `npm run db:seed`. Pulls config from `process.env` (Supabase
// pooled DB URL).

import postgres from "postgres";
import { loadEnv } from "../src/env.js";
import { airports } from "../src/data/airports.js";
import { aircraftTypes } from "../src/data/aircraft.js";
import { cabins } from "../src/data/cabins.js";
import { meals } from "../src/data/meals.js";
import { routes as routeSeeds } from "../src/data/routes.js";
import { flatSeats, seatTemplates } from "../src/data/seat-templates.js";
import { priceJitter } from "../src/lib/pricing.js";

const SEED_DAYS = 30;

// How many flights/day to schedule per route, derived from freq_per_week.
function flightsPerDay(freqPerWeek: number): number[] {
  if (freqPerWeek >= 21) return [8 * 60 + 35, 13 * 60 + 50, 20 * 60 + 10];
  if (freqPerWeek >= 14) return [9 * 60 + 5, 18 * 60 + 40];
  if (freqPerWeek >= 7) return [10 * 60 + 30];
  // Less than daily — operate on certain days of the week. We use the day
  // index modulo 7 against the frequency target.
  return [11 * 60 + 15];
}

function shouldOperateOnDay(freqPerWeek: number, dayIndex: number): boolean {
  if (freqPerWeek >= 7) return true;
  // For 4/wk we want roughly every other day. Simple modular schedule.
  const interval = Math.max(1, Math.round(7 / freqPerWeek));
  return dayIndex % interval === 0;
}

function formatFlightNumber(routeId: number, slotIndex: number): string {
  const base = 100 + routeId * 7;
  const slot = slotIndex * 2;
  return `FL${String(base + slot).padStart(3, "0").slice(-3)}`;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = postgres(env.SUPABASE_DB_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    console.log("[seed] upserting airports");
    for (const airport of airports) {
      await sql`
        insert into public.airports (iata, icao, city, country, continent, lat, lon, tz, is_hub)
        values (
          ${airport.iata}, ${airport.icao}, ${airport.city}, ${airport.country},
          ${airport.continent}, ${airport.lat}, ${airport.lon}, ${airport.tz}, ${airport.isHub}
        )
        on conflict (iata) do update set
          icao = excluded.icao,
          city = excluded.city,
          country = excluded.country,
          continent = excluded.continent,
          lat = excluded.lat,
          lon = excluded.lon,
          tz = excluded.tz,
          is_hub = excluded.is_hub
      `;
    }

    console.log("[seed] upserting aircraft types");
    for (const aircraft of aircraftTypes) {
      await sql`
        insert into public.aircraft_types (
          code, model, seats, range_km, cruise_kmh, introduced_year, role, note
        ) values (
          ${aircraft.code}, ${aircraft.model}, ${aircraft.seats}, ${aircraft.rangeKm},
          ${aircraft.cruiseKmh}, ${aircraft.introducedYear}, ${aircraft.role}, ${aircraft.note}
        )
        on conflict (code) do update set
          model = excluded.model,
          seats = excluded.seats,
          range_km = excluded.range_km,
          cruise_kmh = excluded.cruise_kmh,
          introduced_year = excluded.introduced_year,
          role = excluded.role,
          note = excluded.note
      `;
    }

    console.log("[seed] upserting cabins");
    for (const cabin of cabins) {
      await sql`
        insert into public.cabins (code, name, multiplier, deck, dining, sort_order)
        values (${cabin.code}, ${cabin.name}, ${cabin.multiplier}, ${cabin.deck}, ${cabin.dining}, ${cabin.sortOrder})
        on conflict (code) do update set
          name = excluded.name,
          multiplier = excluded.multiplier,
          deck = excluded.deck,
          dining = excluded.dining,
          sort_order = excluded.sort_order
      `;
    }

    console.log("[seed] upserting meals");
    for (const meal of meals) {
      await sql`
        insert into public.meals (id, name, description, price_eur, cabins, sort_order)
        values (
          ${meal.id}, ${meal.name}, ${meal.description}, ${meal.priceEur},
          ${meal.cabins as unknown as string[]}, ${meal.sortOrder}
        )
        on conflict (id) do update set
          name = excluded.name,
          description = excluded.description,
          price_eur = excluded.price_eur,
          cabins = excluded.cabins,
          sort_order = excluded.sort_order
      `;
    }

    console.log("[seed] upserting seat map templates");
    for (const template of seatTemplates) {
      await sql`
        insert into public.seat_map_templates (aircraft_type, cabin, layout)
        values (
          ${template.aircraftType}, ${template.cabin},
          ${sql.json({ rows: template.rows })}
        )
        on conflict (aircraft_type, cabin) do update set layout = excluded.layout
      `;
    }

    console.log("[seed] upserting routes");
    for (const route of routeSeeds) {
      await sql`
        insert into public.routes (
          from_iata, to_iata, duration_min, fare_from_eur, freq_per_week, haul, default_aircraft
        )
        values (
          ${route.fromIata}, ${route.toIata}, ${route.durationMin}, ${route.fareFromEur},
          ${route.freqPerWeek}, ${route.haul}, ${route.defaultAircraft}
        )
        on conflict (from_iata, to_iata) do update set
          duration_min = excluded.duration_min,
          fare_from_eur = excluded.fare_from_eur,
          freq_per_week = excluded.freq_per_week,
          haul = excluded.haul,
          default_aircraft = excluded.default_aircraft
      `;
    }

    console.log("[seed] clearing future inventory");
    await sql`
      delete from public.flights
      where depart_at >= date_trunc('day', now() at time zone 'utc')
    `;

    console.log("[seed] generating flights for next " + SEED_DAYS + " days");

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const dbRoutes = await sql<
      Array<{
        id: number;
        from_iata: string;
        to_iata: string;
        duration_min: number;
        fare_from_eur: number;
        freq_per_week: number;
        default_aircraft: string;
      }>
    >`select id, from_iata, to_iata, duration_min, fare_from_eur, freq_per_week, default_aircraft from public.routes`;

    let flightCount = 0;
    let seatRowCount = 0;
    let fareRowCount = 0;

    for (let dayIndex = 0; dayIndex < SEED_DAYS; dayIndex++) {
      const departDate = new Date(today);
      departDate.setUTCDate(today.getUTCDate() + dayIndex);

      for (const route of dbRoutes) {
        if (!shouldOperateOnDay(route.freq_per_week, dayIndex)) {
          continue;
        }
        const slots = flightsPerDay(route.freq_per_week);

        for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
          const departureMinutes = slots[slotIndex]!;
          const departAt = new Date(departDate);
          departAt.setUTCMinutes(departureMinutes);
          const arriveAt = addMinutes(departAt, route.duration_min);
          const flightNo = formatFlightNumber(route.id, slotIndex);

          const inserted = await sql<Array<{ id: string }>>`
            insert into public.flights (
              flight_no, route_id, aircraft_type, depart_at, arrive_at, duration_min, status
            ) values (
              ${flightNo}, ${route.id}, ${route.default_aircraft},
              ${departAt.toISOString()}, ${arriveAt.toISOString()},
              ${route.duration_min}, 'scheduled'
            )
            on conflict (flight_no, depart_at) do update set
              arrive_at = excluded.arrive_at,
              duration_min = excluded.duration_min,
              status = excluded.status
            returning id
          `;
          const flightId = inserted[0]!.id;
          flightCount++;

          for (const template of seatTemplates.filter(
            (t) => t.aircraftType === route.default_aircraft,
          )) {
            const seats = flatSeats(template.rows);
            const cabin = template.cabin;

            const cabinRow = cabins.find((entry) => entry.code === cabin)!;
            const jitter = priceJitter(`${flightNo}-${departAt.toISOString().slice(0, 10)}-${cabin}`);
            const baseEur = Math.round(route.fare_from_eur * Number(cabinRow.multiplier) * jitter);
            const taxesEur = Math.round(baseEur * 0.14);
            const surfaceEur = 18;

            for (const seat of seats) {
              await sql`
                insert into public.flight_seats (
                  flight_id, seat_id, cabin, zone, price_eur, status
                ) values (
                  ${flightId}, ${seat.seatId}, ${cabin}, ${seat.zone}, ${seat.priceEur}, 'available'
                )
                on conflict (flight_id, seat_id) do update set
                  zone = excluded.zone,
                  price_eur = excluded.price_eur
              `;
              seatRowCount++;
            }

            await sql`
              insert into public.flight_fares (
                flight_id, cabin, base_eur, taxes_eur, surface_eur, seats_total, seats_available
              ) values (
                ${flightId}, ${cabin}, ${baseEur}, ${taxesEur}, ${surfaceEur},
                ${seats.length}, ${seats.length}
              )
              on conflict (flight_id, cabin) do update set
                base_eur = excluded.base_eur,
                taxes_eur = excluded.taxes_eur,
                surface_eur = excluded.surface_eur,
                seats_total = excluded.seats_total,
                seats_available = excluded.seats_available
            `;
            fareRowCount++;
          }
        }
      }
    }

    console.log(
      `[seed] generated ${flightCount} flights, ${fareRowCount} fare rows, ${seatRowCount} seat rows`,
    );
  } catch (err) {
    console.error("[seed] failed", err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
