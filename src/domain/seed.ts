// Reusable seed pipeline. The CLI script calls this today; a future admin API
// can call the same function to refresh demo data without shelling out.

import type postgres from "postgres";
import { aircraftTypes } from "../data/aircraft.js";
import { airports } from "../data/airports.js";
import { cabins } from "../data/cabins.js";
import { meals } from "../data/meals.js";
import { routes as routeSeeds } from "../data/routes.js";
import { flatSeats, seatTemplates } from "../data/seat-templates.js";
import {
  cabinOccupancy,
  flightNumberFor,
  isSeatTaken,
  modulatePrice,
  operatesOnDay,
  slotsForRoute,
} from "../lib/inventory.js";
import { priceJitter } from "../lib/pricing.js";
import { isoDate, startOfUtcDay } from "../lib/seed-date.js";

const SEED_LOCK_KEY = 1_541_001;

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

export type SeedOptions = {
  baseDate: Date;
  seedDays: number;
  includeDemoBookings?: boolean;
};

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

async function clearTransactionalData(sql: postgres.Sql): Promise<void> {
  console.log("[seed] transactional data");
  await sql`delete from public.seat_holds`;
  await sql`delete from public.payments`;
  await sql`delete from public.passengers`;
  await sql`delete from public.booking_events`;
  await sql`delete from public.booking_segments`;
  await sql`delete from public.bookings`;
}

async function upsertCatalog(sql: postgres.Sql): Promise<void> {
  console.log("[seed] catalog - airports");
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

  console.log("[seed] catalog - aircraft types");
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

  console.log("[seed] catalog - cabins");
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

  console.log("[seed] catalog - meals");
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

  console.log("[seed] catalog - seat map templates");
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

  console.log("[seed] catalog - routes");
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

async function regenerateInventory(
  sql: postgres.Sql,
  options: { baseDate: Date; seedDays: number },
): Promise<void> {
  const today = startOfUtcDay(options.baseDate);
  console.log(`[seed] wiping inventory from ${isoDate(today)}`);
  await sql`
    delete from public.flights
    where depart_at >= ${today.toISOString()}::timestamptz
  `;

  const dbRoutes = await sql<RouteRow[]>`
    select id, from_iata, to_iata, duration_min, fare_from_eur, freq_per_week, default_aircraft
    from public.routes
    order by id
  `;

  let totalFlights = 0;
  let totalFares = 0;
  let totalSeats = 0;
  let totalTaken = 0;
  const startedAt = Date.now();

  for (let dayIndex = 0; dayIndex < options.seedDays; dayIndex++) {
    const departDate = addDays(today, dayIndex);

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

    if ((dayIndex + 1) % 5 === 0 || dayIndex === options.seedDays - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[seed] day ${String(dayIndex + 1).padStart(2, "0")}/${options.seedDays} ` +
          `- flights ${totalFlights} - fares ${totalFares} - ` +
          `seats ${totalSeats} (${totalTaken} taken) - ${elapsed}s`,
      );
    }
  }

  const elapsedTotal = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[seed] inventory done in ${elapsedTotal}s - ${totalFlights} flights, ${totalFares} fare rows, ` +
      `${totalSeats} seat rows (${Math.round((totalTaken / Math.max(1, totalSeats)) * 100)}% taken)`,
  );
}

type DemoPassengerSeed = {
  givenName: string;
  familyName: string;
  loyaltyNo?: string;
  loyaltyTier?: "invite" | "platinum" | "gold" | "silver" | "member";
  serviceTags?: string[];
  preferences?: Record<string, unknown>;
  notes?: string;
  seatId: string | null;
  mealId: string;
};

type DemoBookingSeed = {
  pnr: string;
  sessionId: string;
  from: string;
  to: string;
  dayOffset: number;
  cabin: "A" | "P" | "L";
  status: "draft" | "awaiting_payment" | "confirmed" | "cancelled";
  contact: { name: string; email: string; phone?: string };
  passengers: DemoPassengerSeed[];
  createdAtOffsetMinutes: number;
  confirmedAtOffsetMinutes?: number;
  cancelledAtOffsetMinutes?: number;
  holdExpiresAt?: Date | null;
  payment?: {
    status: "pending" | "succeeded" | "failed" | "refunded";
    cardholder?: string;
    cardLast4?: string;
    cardBrand?: string;
  };
  events?: Array<{
    type: string;
    offsetMinutes: number;
    actor: string;
    details: Record<string, unknown>;
  }>;
};

type DemoFlightRow = {
  id: string;
  flight_no: string;
  depart_at: Date;
  cabin: string;
  base_eur: number;
  taxes_eur: number;
  surface_eur: number;
};

const DEMO_BOOKINGS: Omit<DemoBookingSeed, "holdExpiresAt">[] = [
  {
    pnr: "VIP001",
    sessionId: "11111111-1111-4111-8111-111111111111",
    from: "LHR",
    to: "JFK",
    dayOffset: 1,
    cabin: "A",
    status: "confirmed",
    contact: {
      name: "Amara Okafor",
      email: "amara.okafor@example.com",
      phone: "+44 20 7946 0101",
    },
    passengers: [
      {
        givenName: "Amara",
        familyName: "Okafor",
        loyaltyNo: "FL-INV-00017",
        loyaltyTier: "invite",
        serviceTags: ["vip", "corporate_contract", "tight_connection"],
        preferences: {
          preferredDrink: "sparkling water with lime",
          language: "en-GB",
          connection: "JFK private transfer, 70 minute connection buffer",
        },
        notes: "Boarding lead should greet by name. Prefers quiet service and no cabin announcements at seat.",
        seatId: "1A",
        mealId: "atelier-tasting",
      },
    ],
    createdAtOffsetMinutes: -7 * 24 * 60 + 75,
    confirmedAtOffsetMinutes: -7 * 24 * 60 + 92,
    payment: {
      status: "succeeded",
      cardholder: "Amara Okafor",
      cardLast4: "0042",
      cardBrand: "Visa",
    },
    events: [
      {
        type: "vip_profile_synced",
        offsetMinutes: -6 * 24 * 60,
        actor: "loyalty",
        details: { tier: "invite", accountManager: "FlyLo Corporate Desk" },
      },
    ],
  },
  {
    pnr: "BIZ001",
    sessionId: "22222222-2222-4222-8222-222222222222",
    from: "SFO",
    to: "HND",
    dayOffset: 2,
    cabin: "P",
    status: "confirmed",
    contact: {
      name: "Northstar Robotics Travel",
      email: "travel@northstar-robotics.example",
    },
    passengers: [
      {
        givenName: "Mina",
        familyName: "Chen",
        loyaltyNo: "FL-PLT-48291",
        loyaltyTier: "platinum",
        serviceTags: ["corporate_contract", "quiet_workspace"],
        preferences: { workMode: "do not disturb until meal service", preferredDrink: "green tea" },
        notes: "CEO of Northstar Robotics; travelling with engineering leads.",
        seatId: "6A",
        mealId: "sleep-service",
      },
      {
        givenName: "Theo",
        familyName: "Bennett",
        loyaltyNo: "FL-GLD-11408",
        loyaltyTier: "gold",
        serviceTags: ["corporate_contract"],
        preferences: { preferredDrink: "black coffee" },
        notes: "Needs power outlet reminder before departure.",
        seatId: "6C",
        mealId: "seasonal",
      },
      {
        givenName: "Priya",
        familyName: "Raman",
        loyaltyNo: "FL-GLD-78012",
        loyaltyTier: "gold",
        serviceTags: ["corporate_contract", "dietary_attention"],
        preferences: { dietary: "vegetarian", preferredDrink: "still water" },
        notes: "Vegetarian meal preference confirmed.",
        seatId: "7A",
        mealId: "plant-forward",
      },
    ],
    createdAtOffsetMinutes: -5 * 24 * 60 + 140,
    confirmedAtOffsetMinutes: -5 * 24 * 60 + 151,
    payment: {
      status: "succeeded",
      cardholder: "Northstar Robotics",
      cardLast4: "1045",
      cardBrand: "Mastercard",
    },
    events: [
      {
        type: "corporate_booking_created",
        offsetMinutes: -5 * 24 * 60 + 140,
        actor: "corporate_portal",
        details: { company: "Northstar Robotics", contract: "NSR-2026" },
      },
    ],
  },
  {
    pnr: "FAM001",
    sessionId: "33333333-3333-4333-8333-333333333333",
    from: "LHR",
    to: "CDG",
    dayOffset: 5,
    cabin: "L",
    status: "confirmed",
    contact: {
      name: "Jonas Meyer",
      email: "jonas.meyer@example.com",
    },
    passengers: [
      {
        givenName: "Jonas",
        familyName: "Meyer",
        loyaltyNo: "FL-SLV-30219",
        loyaltyTier: "silver",
        serviceTags: ["family_travel"],
        preferences: { seating: "keep family together" },
        notes: "Travelling with two children; offer early boarding if available.",
        seatId: "12A",
        mealId: "seasonal",
      },
      {
        givenName: "Lea",
        familyName: "Meyer",
        loyaltyNo: "FL-MBR-30220",
        loyaltyTier: "member",
        serviceTags: ["family_travel"],
        preferences: { seating: "keep family together" },
        notes: "Prefers aisle access for children.",
        seatId: "12B",
        mealId: "plant-forward",
      },
      {
        givenName: "Nora",
        familyName: "Meyer",
        serviceTags: ["family_travel", "child"],
        preferences: { ageGroup: "child", snack: "fruit" },
        notes: "Child passenger; parent seated adjacent.",
        seatId: "12C",
        mealId: "linen-comfort",
      },
      {
        givenName: "Finn",
        familyName: "Meyer",
        serviceTags: ["family_travel", "child"],
        preferences: { ageGroup: "child", snack: "chocolate sable" },
        notes: "Child passenger; parent seated adjacent.",
        seatId: "12D",
        mealId: "linen-comfort",
      },
    ],
    createdAtOffsetMinutes: -3 * 24 * 60 + 90,
    confirmedAtOffsetMinutes: -3 * 24 * 60 + 103,
    payment: {
      status: "succeeded",
      cardholder: "Jonas Meyer",
      cardLast4: "7788",
      cardBrand: "Visa",
    },
  },
  {
    pnr: "RBKOLD",
    sessionId: "44444444-4444-4444-8444-444444444444",
    from: "CDG",
    to: "JFK",
    dayOffset: 1,
    cabin: "P",
    status: "cancelled",
    contact: {
      name: "Isabelle Laurent",
      email: "isabelle.laurent@example.com",
    },
    passengers: [
      {
        givenName: "Isabelle",
        familyName: "Laurent",
        loyaltyNo: "FL-PLT-66120",
        loyaltyTier: "platinum",
        serviceTags: ["service_recovery"],
        preferences: { disruption: "weather cancellation on original itinerary" },
        notes: "Original booking cancelled after operational disruption; see RBK001.",
        seatId: null,
        mealId: "seasonal",
      },
    ],
    createdAtOffsetMinutes: -4 * 24 * 60 + 120,
    cancelledAtOffsetMinutes: -24 * 60 + 45,
    payment: {
      status: "refunded",
      cardholder: "Isabelle Laurent",
      cardLast4: "6120",
      cardBrand: "Amex",
    },
    events: [
      {
        type: "flight_disrupted",
        offsetMinutes: -24 * 60 + 20,
        actor: "operations",
        details: { reason: "weather", replacementPnr: "RBK001" },
      },
      {
        type: "rebooked_to",
        offsetMinutes: -24 * 60 + 45,
        actor: "care_agent",
        details: { newPnr: "RBK001", waiverCode: "WX-CARE" },
      },
    ],
  },
  {
    pnr: "RBK001",
    sessionId: "55555555-5555-4555-8555-555555555555",
    from: "CDG",
    to: "DXB",
    dayOffset: 3,
    cabin: "P",
    status: "confirmed",
    contact: {
      name: "Isabelle Laurent",
      email: "isabelle.laurent@example.com",
    },
    passengers: [
      {
        givenName: "Isabelle",
        familyName: "Laurent",
        loyaltyNo: "FL-PLT-66120",
        loyaltyTier: "platinum",
        serviceTags: ["service_recovery", "vip", "dietary_attention"],
        preferences: {
          dietary: "gluten-free",
          serviceRecovery: "offer lounge invitation and onboard welcome",
        },
        notes: "Rebooked from RBKOLD after disruption. Apologize proactively and confirm gluten-free meal.",
        seatId: "6D",
        mealId: "plant-forward",
      },
    ],
    createdAtOffsetMinutes: -24 * 60 + 45,
    confirmedAtOffsetMinutes: -24 * 60 + 51,
    payment: {
      status: "succeeded",
      cardholder: "Isabelle Laurent",
      cardLast4: "6120",
      cardBrand: "Amex",
    },
    events: [
      {
        type: "rebooked_from",
        offsetMinutes: -24 * 60 + 45,
        actor: "care_agent",
        details: { originalPnr: "RBKOLD", reason: "weather disruption", waiverCode: "WX-CARE" },
      },
      {
        type: "service_recovery_added",
        offsetMinutes: -24 * 60 + 48,
        actor: "care_agent",
        details: { gesture: "lounge invitation", priority: "high" },
      },
    ],
  },
];

function activeHoldBooking(baseDate: Date): DemoBookingSeed {
  return {
    pnr: "HLD001",
    sessionId: "66666666-6666-4666-8666-666666666666",
    from: "SFO",
    to: "LHR",
    dayOffset: 1,
    cabin: "P",
    status: "awaiting_payment",
    contact: {
      name: "Mateo Silva",
      email: "mateo.silva@example.com",
    },
    passengers: [
      {
        givenName: "Mateo",
        familyName: "Silva",
        loyaltyNo: "FL-GLD-55002",
        loyaltyTier: "gold",
        serviceTags: ["upgrade_interest"],
        preferences: { upsell: "interested in Atlas waitlist" },
        notes: "Payment pending; seat should appear held during sales demo.",
        seatId: "8F",
        mealId: "sleep-service",
      },
    ],
    createdAtOffsetMinutes: Math.max(0, Math.floor((Date.now() - baseDate.getTime()) / 60000) - 2),
    holdExpiresAt: addMinutes(new Date(), 30),
    payment: { status: "pending" },
    events: [
      {
        type: "payment_intent_created",
        offsetMinutes: Math.max(0, Math.floor((Date.now() - baseDate.getTime()) / 60000) - 1),
        actor: "booking_flow",
        details: { demoState: "awaiting_payment" },
      },
    ],
  };
}

async function findDemoFlight(
  sql: postgres.TransactionSql,
  scenario: Pick<DemoBookingSeed, "from" | "to" | "dayOffset" | "cabin">,
  baseDate: Date,
): Promise<DemoFlightRow> {
  const dayStart = addDays(baseDate, scenario.dayOffset);
  const dayEnd = addDays(dayStart, 1);
  const rows = (await sql`
    select f.id, f.flight_no, f.depart_at, ff.cabin, ff.base_eur, ff.taxes_eur, ff.surface_eur
    from public.flights f
    join public.routes r on r.id = f.route_id
    join public.flight_fares ff on ff.flight_id = f.id and ff.cabin = ${scenario.cabin}
    where r.from_iata = ${scenario.from}
      and r.to_iata = ${scenario.to}
      and f.depart_at >= ${dayStart.toISOString()}::timestamptz
      and f.depart_at < ${dayEnd.toISOString()}::timestamptz
    order by f.depart_at asc
    limit 1
  `) as unknown as DemoFlightRow[];

  const flight = rows[0];
  if (!flight) {
    throw new Error(
      `No seeded flight found for ${scenario.from}-${scenario.to} ${scenario.cabin} on ${isoDate(dayStart)}`,
    );
  }
  return flight;
}

async function resetDemoCabin(
  tx: postgres.TransactionSql,
  flightId: string,
  cabin: string,
): Promise<void> {
  await tx`
    update public.flight_seats
    set status = 'available'
    where flight_id = ${flightId} and cabin = ${cabin}
  `;
}

async function recalculateCabinAvailability(
  tx: postgres.TransactionSql,
  flightId: string,
  cabin: string,
): Promise<void> {
  const rows = (await tx`
    select
      count(*)::int as seats_total,
      count(*) filter (where status = 'available')::int as seats_available
    from public.flight_seats
    where flight_id = ${flightId} and cabin = ${cabin}
  `) as unknown as Array<{ seats_total: number; seats_available: number }>;
  const row = rows[0] ?? { seats_total: 0, seats_available: 0 };
  await tx`
    update public.flight_fares
    set seats_total = ${row.seats_total},
        seats_available = ${row.seats_available}
    where flight_id = ${flightId} and cabin = ${cabin}
  `;
}

async function insertDemoBooking(
  tx: postgres.TransactionSql,
  scenario: DemoBookingSeed,
  flight: DemoFlightRow,
  baseDate: Date,
): Promise<void> {
  const createdAt = addMinutes(baseDate, scenario.createdAtOffsetMinutes);
  const confirmedAt =
    scenario.status === "confirmed" && scenario.confirmedAtOffsetMinutes != null
      ? addMinutes(baseDate, scenario.confirmedAtOffsetMinutes)
      : null;
  const cancelledAt =
    scenario.status === "cancelled" && scenario.cancelledAtOffsetMinutes != null
      ? addMinutes(baseDate, scenario.cancelledAtOffsetMinutes)
      : null;
  const holdExpiresAt = scenario.holdExpiresAt ?? null;
  const pax = scenario.passengers.length;

  const seatRows =
    scenario.passengers.filter((passenger) => passenger.seatId).length > 0
      ? ((await tx`
          select seat_id, price_eur
          from public.flight_seats
          where flight_id = ${flight.id}
            and seat_id in ${tx(scenario.passengers.flatMap((passenger) => passenger.seatId ? [passenger.seatId] : []))}
        `) as unknown as Array<{ seat_id: string; price_eur: number }>)
      : [];
  const seatPriceById = new Map(seatRows.map((row) => [row.seat_id, row.price_eur]));
  const seatsEur = scenario.passengers.reduce(
    (sum, passenger) => sum + (passenger.seatId ? seatPriceById.get(passenger.seatId) ?? 0 : 0),
    0,
  );

  const mealRows = (await tx`
    select id, price_eur
    from public.meals
    where id in ${tx([...new Set(scenario.passengers.map((passenger) => passenger.mealId))])}
  `) as unknown as Array<{ id: string; price_eur: number }>;
  const mealPriceById = new Map(mealRows.map((row) => [row.id, row.price_eur]));
  const mealsEur = scenario.passengers.reduce(
    (sum, passenger) => sum + (mealPriceById.get(passenger.mealId) ?? 0),
    0,
  );

  const baseEur = flight.base_eur * pax;
  const taxesEur = flight.taxes_eur * pax;
  const surfaceEur = flight.surface_eur * pax;
  const totalEur = baseEur + seatsEur + mealsEur + taxesEur + surfaceEur;

  await tx`
    insert into public.bookings (
      pnr, session_id, status, contact, pax,
      base_eur, seats_eur, meals_eur, taxes_eur, surface_eur, total_eur,
      hold_expires_at, created_at, updated_at, confirmed_at, cancelled_at
    ) values (
      ${scenario.pnr}, ${scenario.sessionId}, ${scenario.status}, ${tx.json(scenario.contact)}, ${pax},
      ${baseEur}, ${seatsEur}, ${mealsEur}, ${taxesEur}, ${surfaceEur}, ${totalEur},
      ${holdExpiresAt?.toISOString() ?? null}, ${createdAt.toISOString()}, ${createdAt.toISOString()},
      ${confirmedAt?.toISOString() ?? null}, ${cancelledAt?.toISOString() ?? null}
    )
  `;

  await tx`
    insert into public.booking_segments (booking_pnr, flight_id, cabin, segment_no)
    values (${scenario.pnr}, ${flight.id}, ${scenario.cabin}, 1)
  `;

  for (let i = 0; i < scenario.passengers.length; i++) {
    const passenger = scenario.passengers[i]!;
    await tx`
      insert into public.passengers (
        booking_pnr, passenger_no, given_name, family_name, loyalty_no,
        loyalty_tier, service_tags, preferences, notes, seat_id, meal_id
      ) values (
        ${scenario.pnr}, ${i + 1}, ${passenger.givenName}, ${passenger.familyName},
        ${passenger.loyaltyNo ?? null}, ${passenger.loyaltyTier ?? null},
        ${passenger.serviceTags ?? []}, ${JSON.stringify(passenger.preferences ?? {})}::jsonb,
        ${passenger.notes ?? null}, ${passenger.seatId}, ${passenger.mealId}
      )
    `;
  }

  const occupiedSeatIds = scenario.passengers.flatMap((passenger) =>
    passenger.seatId ? [passenger.seatId] : [],
  );
  if (occupiedSeatIds.length > 0 && scenario.status !== "cancelled") {
    const seatStatus = scenario.status === "confirmed" ? "taken" : "held";
    await tx`
      update public.flight_seats
      set status = ${seatStatus}
      where flight_id = ${flight.id}
        and seat_id in ${tx(occupiedSeatIds)}
    `;

    if (seatStatus === "held" && holdExpiresAt) {
      for (const seatId of occupiedSeatIds) {
        await tx`
          insert into public.seat_holds (flight_id, seat_id, session_id, expires_at)
          values (${flight.id}, ${seatId}, ${scenario.sessionId}, ${holdExpiresAt.toISOString()})
        `;
      }
    }
  }

  if (scenario.payment) {
    const completedAt =
      scenario.payment.status === "succeeded" || scenario.payment.status === "refunded"
        ? confirmedAt ?? cancelledAt ?? createdAt
        : null;
    await tx`
      insert into public.payments (
        booking_pnr, provider, status, amount_eur, cardholder, card_last4, card_brand,
        created_at, completed_at
      ) values (
        ${scenario.pnr}, 'mock', ${scenario.payment.status}, ${totalEur},
        ${scenario.payment.cardholder ?? null}, ${scenario.payment.cardLast4 ?? null},
        ${scenario.payment.cardBrand ?? null}, ${createdAt.toISOString()},
        ${completedAt?.toISOString() ?? null}
      )
    `;
  }

  for (const event of scenario.events ?? []) {
    await tx`
      insert into public.booking_events (booking_pnr, event_type, occurred_at, actor, details)
      values (
        ${scenario.pnr}, ${event.type}, ${addMinutes(baseDate, event.offsetMinutes).toISOString()},
        ${event.actor}, ${JSON.stringify(event.details)}::jsonb
      )
    `;
  }
}

async function seedDemoBookings(sql: postgres.Sql, baseDate: Date): Promise<void> {
  console.log("[seed] demo bookings");
  const scenarios: DemoBookingSeed[] = [...DEMO_BOOKINGS, activeHoldBooking(baseDate)];
  const touchedCabins = new Set<string>();

  await sql.begin(async (tx) => {
    for (const scenario of scenarios) {
      const flight = await findDemoFlight(tx, scenario, baseDate);
      const key = `${flight.id}|${scenario.cabin}`;
      if (!touchedCabins.has(key)) {
        await resetDemoCabin(tx, flight.id, scenario.cabin);
        touchedCabins.add(key);
      }
      await insertDemoBooking(tx, scenario, flight, baseDate);
    }

    for (const key of touchedCabins) {
      const [flightId, cabin] = key.split("|");
      if (flightId && cabin) {
        await recalculateCabinAvailability(tx, flightId, cabin);
      }
    }
  });

  console.log(`[seed] demo bookings done - ${scenarios.length} bookings`);
}

export async function seedDatabase(sql: postgres.Sql, options: SeedOptions): Promise<void> {
  const baseDate = startOfUtcDay(options.baseDate);
  const seedDays = options.seedDays;
  const includeDemoBookings = options.includeDemoBookings ?? true;

  await sql`select pg_advisory_lock(${SEED_LOCK_KEY})`;
  try {
    console.log(`[seed] base date ${isoDate(baseDate)} - ${seedDays} days`);
    await clearTransactionalData(sql);
    await upsertCatalog(sql);
    await regenerateInventory(sql, { baseDate, seedDays });
    if (includeDemoBookings) {
      await seedDemoBookings(sql, baseDate);
    }
  } finally {
    await sql`select pg_advisory_unlock(${SEED_LOCK_KEY})`;
  }
}

