// Seed script. Idempotent — safe to re-run.
//
// Pipeline:
//
//   1. Upsert catalog (airports, aircraft_types, cabins, meals,
//      seat_map_templates, routes).
//   2. Delete future inventory (flights, fares, seats) — cascades clean
//      out via FK ON DELETE CASCADE.
//   3. Regenerate `SEED_DAYS` of inventory:
//        - flights with realistic per-route departure-time patterns
//        - flight_fares with day-of-week + advance-purchase modulation
//        - flight_seats with deterministic taken/available split
//        - flight_fares.seats_available reflects the taken count
//
// All randomness is deterministic so the seed is fully reproducible.
//
// Inserts are batched per (day, table) so the run stays under a minute
// even with ~9k flights and ~250k seat rows.

import postgres from "postgres";
import { loadEnv } from "../src/env.js";
import { airports } from "../src/data/airports.js";
import { aircraftTypes } from "../src/data/aircraft.js";
import { cabins } from "../src/data/cabins.js";
import { meals } from "../src/data/meals.js";
import { routes as routeSeeds } from "../src/data/routes.js";
import { flatSeats, seatTemplates } from "../src/data/seat-templates.js";
import { priceJitter } from "../src/lib/pricing.js";
import {
  cabinOccupancy,
  flightNumberFor,
  isSeatTaken,
  modulatePrice,
  operatesOnDay,
  slotsForRoute,
} from "../src/lib/inventory.js";

const SEED_DAYS = Number(process.env.SEED_DAYS ?? 45);

type RouteRow = {
  id: number;
  from_iata: string;
  to_iata: string;
  duration_min: number;
  fare_from_eur: number;
  freq_per_week: number;
  default_aircraft: string;
};

type FlightInsert = {
  flight_no: string;
  route_id: number;
  aircraft_type: string;
  depart_at: string;
  arrive_at: string;
  duration_min: number;
  status: string;
};

type FareInsert = {
  flight_id: string;
  cabin: string;
  base_eur: number;
  taxes_eur: number;
  surface_eur: number;
  seats_total: number;
  seats_available: number;
};

type SeatInsert = {
  flight_id: string;
  seat_id: string;
  cabin: string;
  zone: string;
  price_eur: number;
  status: "available" | "held" | "taken" | "blocked";
};

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

async function upsertCatalog(sql: postgres.Sql): Promise<void> {
  console.log("[seed] catalog · airports");
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

  console.log("[seed] catalog · aircraft types");
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

  console.log("[seed] catalog · cabins");
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

  console.log("[seed] catalog · meals");
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

  console.log("[seed] catalog · seat map templates");
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

  console.log("[seed] catalog · routes");
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
}

async function regenerateInventory(sql: postgres.Sql): Promise<void> {
  console.log("[seed] wiping future inventory");
  await sql`
    delete from public.flights
    where depart_at >= date_trunc('day', now() at time zone 'utc')
  `;

  const dbRoutes = await sql<RouteRow[]>`
    select id, from_iata, to_iata, duration_min, fare_from_eur, freq_per_week, default_aircraft
    from public.routes
    order by id
  `;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let totalFlights = 0;
  let totalFares = 0;
  let totalSeats = 0;
  let totalTaken = 0;
  const startedAt = Date.now();

  for (let dayIndex = 0; dayIndex < SEED_DAYS; dayIndex++) {
    const departDate = new Date(today);
    departDate.setUTCDate(today.getUTCDate() + dayIndex);

    const flightsForDay: FlightInsert[] = [];
    type Pending = {
      flightInsert: FlightInsert;
      route: RouteRow;
      departAt: Date;
    };
    const pending: Pending[] = [];

    for (const route of dbRoutes) {
      if (!operatesOnDay(route.freq_per_week, dayIndex)) {
        continue;
      }
      const slots = slotsForRoute({
        routeId: route.id,
        freqPerWeek: route.freq_per_week,
      });

      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const departureMinutes = slots[slotIndex]!;
        const departAt = new Date(departDate);
        departAt.setUTCMinutes(departureMinutes);
        const arriveAt = addMinutes(departAt, route.duration_min);
        const flightNo = flightNumberFor(route.id, slotIndex);

        const flightInsert: FlightInsert = {
          flight_no: flightNo,
          route_id: route.id,
          aircraft_type: route.default_aircraft,
          depart_at: departAt.toISOString(),
          arrive_at: arriveAt.toISOString(),
          duration_min: route.duration_min,
          status: "scheduled",
        };
        flightsForDay.push(flightInsert);
        pending.push({ flightInsert, route, departAt });
      }
    }

    if (flightsForDay.length === 0) {
      continue;
    }

    const flightInsertHelper = sql(
      flightsForDay,
      "flight_no",
      "route_id",
      "aircraft_type",
      "depart_at",
      "arrive_at",
      "duration_min",
      "status",
    );
    const insertedFlights = (await sql`
      insert into public.flights ${flightInsertHelper}
      on conflict (flight_no, depart_at) do update set
        arrive_at = excluded.arrive_at,
        aircraft_type = excluded.aircraft_type,
        duration_min = excluded.duration_min,
        status = excluded.status
      returning id, flight_no, depart_at
    `) as unknown as Array<{ id: string; flight_no: string; depart_at: Date }>;
    totalFlights += insertedFlights.length;

    // Map (flight_no, depart_at ISO) → flight_id so we can build the
    // dependent fare + seat rows in bulk.
    const flightIdByKey = new Map<string, string>();
    for (const row of insertedFlights) {
      const key = `${row.flight_no}|${new Date(row.depart_at).toISOString()}`;
      flightIdByKey.set(key, row.id);
    }

    const fareRows: FareInsert[] = [];
    const seatRows: SeatInsert[] = [];

    for (const { flightInsert, route, departAt } of pending) {
      const key = `${flightInsert.flight_no}|${departAt.toISOString()}`;
      const flightId = flightIdByKey.get(key);
      if (!flightId) {
        continue;
      }

      for (const template of seatTemplates.filter(
        (t) => t.aircraftType === route.default_aircraft,
      )) {
        const cabin = template.cabin;
        const cabinRow = cabins.find((entry) => entry.code === cabin)!;
        const seats = flatSeats(template.rows);

        const jitter = priceJitter(
          `${flightInsert.flight_no}-${departAt.toISOString().slice(0, 10)}-${cabin}`,
        );
        const baseBeforeModulation = Math.round(
          route.fare_from_eur * Number(cabinRow.multiplier) * jitter,
        );
        const baseEur = modulatePrice({
          baseEur: baseBeforeModulation,
          departAt,
          referenceDate: today,
        });
        const taxesEur = Math.round(baseEur * 0.14);
        const surfaceEur = 18;

        const occupancyRate = cabinOccupancy({
          cabin,
          freqPerWeek: route.freq_per_week,
          departAt,
          referenceDate: today,
        });

        let takenInCabin = 0;
        for (const seat of seats) {
          const taken = isSeatTaken(flightId, seat.seatId, cabin, occupancyRate);
          if (taken) {
            takenInCabin++;
            totalTaken++;
          }
          seatRows.push({
            flight_id: flightId,
            seat_id: seat.seatId,
            cabin,
            zone: seat.zone,
            price_eur: seat.priceEur,
            status: taken ? "taken" : "available",
          });
        }

        const seatsTotal = seats.length;
        const seatsAvailable = Math.max(0, seatsTotal - takenInCabin);

        fareRows.push({
          flight_id: flightId,
          cabin,
          base_eur: baseEur,
          taxes_eur: taxesEur,
          surface_eur: surfaceEur,
          seats_total: seatsTotal,
          seats_available: seatsAvailable,
        });
      }
    }

    if (fareRows.length > 0) {
      const fareHelper = sql(
        fareRows,
        "flight_id",
        "cabin",
        "base_eur",
        "taxes_eur",
        "surface_eur",
        "seats_total",
        "seats_available",
      );
      await sql`
        insert into public.flight_fares ${fareHelper}
        on conflict (flight_id, cabin) do update set
          base_eur = excluded.base_eur,
          taxes_eur = excluded.taxes_eur,
          surface_eur = excluded.surface_eur,
          seats_total = excluded.seats_total,
          seats_available = excluded.seats_available
      `;
      totalFares += fareRows.length;
    }

    if (seatRows.length > 0) {
      const chunkSize = 1000;
      for (let i = 0; i < seatRows.length; i += chunkSize) {
        const chunk = seatRows.slice(i, i + chunkSize);
        const seatHelper = sql(
          chunk,
          "flight_id",
          "seat_id",
          "cabin",
          "zone",
          "price_eur",
          "status",
        );
        await sql`
          insert into public.flight_seats ${seatHelper}
          on conflict (flight_id, seat_id) do update set
            zone = excluded.zone,
            price_eur = excluded.price_eur,
            status = excluded.status
        `;
        totalSeats += chunk.length;
      }
    }

    if ((dayIndex + 1) % 5 === 0 || dayIndex === SEED_DAYS - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[seed] day ${String(dayIndex + 1).padStart(2, "0")}/${SEED_DAYS} ` +
          `· flights ${totalFlights} · fares ${totalFares} · ` +
          `seats ${totalSeats} (${totalTaken} taken) · ${elapsed}s`,
      );
    }
  }

  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[seed] done in ${elapsedTotal}s — ${totalFlights} flights, ${totalFares} fare rows, ` +
      `${totalSeats} seat rows (${Math.round((totalTaken / Math.max(1, totalSeats)) * 100)}% taken)`,
  );
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
    await upsertCatalog(sql);
    await regenerateInventory(sql);
  } catch (err) {
    console.error("[seed] failed", err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
