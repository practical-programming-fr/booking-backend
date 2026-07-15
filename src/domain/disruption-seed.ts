// Seeded disruption scenario for the FlyLo Ops Agent demo.
//
// Produces a deterministic, demo-ready cancellation scenario on top of the
// normal seed: flight FL228 (London LHR to Chicago ORD) departing later today
// with ~40 booked passengers, a good fraction carrying an onward connecting
// segment out of ORD (so misconnect reasoning is demoable), plus a handful of
// same-day alternative LHR to ORD flights with real seat availability across
// cabins to rebook into.
//
// The plan is built by a pure function (buildDisruptionPlan) so its shape can
// be unit tested without a database; seedDisruptionScenario applies it. It is
// idempotent and safe to run on every nightly reseed: flights upsert on
// (flight_no, depart_at) and the surrounding seed clears transactional data
// first.

import type postgres from "postgres";
import { cabins } from "../data/cabins.js";
import { flatSeats, seatTemplates } from "../data/seat-templates.js";
import { startOfUtcDay } from "../lib/seed-date.js";
import { isSeatTaken } from "../lib/inventory.js";

export const PRIMARY_FLIGHT_NO = "FL228";
const LHR_ORD_DURATION_MIN = 540;
const ORD_SFO_DURATION_MIN = 265;

// Base fares per route leg (mirrors src/data/routes.ts baseFares for the
// destination). Kept local so the plan math is self-contained and testable.
const ROUTE_FARE_EUR: Record<RouteKey, number> = {
  "LHR-ORD": 690,
  "ORD-SFO": 880,
};

const AIRCRAFT_LHR_ORD = "A350-900";
const AIRCRAFT_ORD_SFO = "A321XLR";

type RouteKey = "LHR-ORD" | "ORD-SFO";
type CabinCode = "A" | "P" | "L";
type FlightRole = "primary" | "alternative" | "onward";

export type ScenarioFlightSpec = {
  flightNo: string;
  routeKey: RouteKey;
  aircraftType: string;
  departAt: Date;
  arriveAt: Date;
  durationMin: number;
  role: FlightRole;
  // Multiplier applied to the per-cabin base fare so alternatives differ in
  // price and the fare delta is rankable.
  baseFactor: number;
  // Deterministic pre-existing occupancy for non-primary flights (the primary
  // flight is filled by the seeded bookings instead).
  occupancy: number;
};

export type ScenarioPassengerSpec = {
  givenName: string;
  familyName: string;
  loyaltyTier: string | null;
  serviceTags: string[];
};

export type ScenarioBookingSpec = {
  pnr: string;
  sessionId: string;
  contact: { name: string; email: string; phone: string };
  cabin: CabinCode;
  status: "confirmed" | "awaiting_payment";
  passenger: ScenarioPassengerSpec;
  hasConnection: boolean;
  onwardFlightNo: string | null;
  onwardCabin: CabinCode | null;
};

export type DisruptionPlan = {
  primaryFlightNo: string;
  primaryDepartAt: Date;
  flights: ScenarioFlightSpec[];
  bookings: ScenarioBookingSpec[];
};

const GIVEN_NAMES = [
  "Aiden", "Bianca", "Cyrus", "Dahlia", "Ezra", "Farah", "Gideon", "Hana",
  "Ivo", "Juno", "Kiran", "Lena", "Mateo", "Nadia", "Omar", "Petra",
  "Quinn", "Rania", "Soren", "Tessa", "Ugo", "Vera", "Wes", "Xena",
  "Yusuf", "Zara", "Arlo", "Beatrix", "Cormac", "Delia", "Emil", "Faye",
  "Gael", "Hedy", "Idris", "Juniper", "Kai", "Liora", "Milan", "Noor",
];

const FAMILY_NAMES = [
  "Abara", "Bright", "Cardoso", "Delgado", "Espinoza", "Fenwick", "Grover",
  "Halvorsen", "Iqbal", "Jansson", "Kovac", "Larsen", "Munro", "Novak",
  "Oduya", "Pereira", "Quan", "Rossi", "Sharma", "Tran", "Ueno", "Vidal",
  "Weiss", "Xu", "Yamada", "Zettel", "Achebe", "Bauer", "Costa", "Duarte",
  "Everett", "Ferreira", "Ghosh", "Holt", "Imani", "Jokinen", "Kaur",
  "Lindqvist", "Moreau", "Nakamura",
];

// Per-cabin booked counts on the primary flight (total 40). Leaves headroom in
// each cabin so the flight is near-full but not overbooked (A: 10 seats, P: 16,
// L: 24 with the seeded seat templates).
const BOOKED_A = 6;
const BOOKED_P = 12;
const BOOKED_L = 22;

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function ceilToHour(date: Date): Date {
  const result = new Date(date);
  if (result.getUTCMinutes() !== 0 || result.getUTCSeconds() !== 0 || result.getUTCMilliseconds() !== 0) {
    result.setUTCMinutes(0, 0, 0);
    result.setUTCHours(result.getUTCHours() + 1);
  }
  return result;
}

function scenarioUuid(index: number): string {
  return `d15c0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * Build the deterministic disruption plan for a seed run. `now` is used only to
 * keep FL228 in the future when a run happens later in the day; the nightly
 * reseed (which runs at a fixed early hour) always lands on 13:00 UTC.
 */
export function buildDisruptionPlan(baseDate: Date, now: Date = new Date()): DisruptionPlan {
  const dayStart = startOfUtcDay(baseDate);
  let primaryDepart = new Date(dayStart);
  primaryDepart.setUTCHours(13, 0, 0, 0);
  const earliest = ceilToHour(addHours(now, 3));
  if (primaryDepart.getTime() < earliest.getTime()) {
    primaryDepart = earliest;
  }

  const onwardDay = startOfUtcDay(addHours(primaryDepart, 24));
  const onward1 = new Date(onwardDay);
  onward1.setUTCHours(9, 0, 0, 0);
  const onward2 = new Date(onwardDay);
  onward2.setUTCHours(11, 30, 0, 0);

  const flights: ScenarioFlightSpec[] = [
    {
      flightNo: PRIMARY_FLIGHT_NO,
      routeKey: "LHR-ORD",
      aircraftType: AIRCRAFT_LHR_ORD,
      departAt: primaryDepart,
      arriveAt: addMinutes(primaryDepart, LHR_ORD_DURATION_MIN),
      durationMin: LHR_ORD_DURATION_MIN,
      role: "primary",
      baseFactor: 1,
      occupancy: 0,
    },
    {
      flightNo: "FL230",
      routeKey: "LHR-ORD",
      aircraftType: AIRCRAFT_LHR_ORD,
      departAt: addHours(primaryDepart, 2),
      arriveAt: addMinutes(addHours(primaryDepart, 2), LHR_ORD_DURATION_MIN),
      durationMin: LHR_ORD_DURATION_MIN,
      role: "alternative",
      baseFactor: 0.95,
      occupancy: 0.25,
    },
    {
      flightNo: "FL232",
      routeKey: "LHR-ORD",
      aircraftType: AIRCRAFT_LHR_ORD,
      departAt: addHours(primaryDepart, 4),
      arriveAt: addMinutes(addHours(primaryDepart, 4), LHR_ORD_DURATION_MIN),
      durationMin: LHR_ORD_DURATION_MIN,
      role: "alternative",
      baseFactor: 1.08,
      occupancy: 0.3,
    },
    {
      flightNo: "FL234",
      routeKey: "LHR-ORD",
      aircraftType: AIRCRAFT_LHR_ORD,
      departAt: addHours(primaryDepart, 6),
      arriveAt: addMinutes(addHours(primaryDepart, 6), LHR_ORD_DURATION_MIN),
      durationMin: LHR_ORD_DURATION_MIN,
      role: "alternative",
      baseFactor: 1.03,
      occupancy: 0.2,
    },
    {
      flightNo: "FL240",
      routeKey: "ORD-SFO",
      aircraftType: AIRCRAFT_ORD_SFO,
      departAt: onward1,
      arriveAt: addMinutes(onward1, ORD_SFO_DURATION_MIN),
      durationMin: ORD_SFO_DURATION_MIN,
      role: "onward",
      baseFactor: 1,
      occupancy: 0.25,
    },
    {
      flightNo: "FL242",
      routeKey: "ORD-SFO",
      aircraftType: AIRCRAFT_ORD_SFO,
      departAt: onward2,
      arriveAt: addMinutes(onward2, ORD_SFO_DURATION_MIN),
      durationMin: ORD_SFO_DURATION_MIN,
      role: "onward",
      baseFactor: 1,
      occupancy: 0.25,
    },
  ];

  const cabinPlan: CabinCode[] = [
    ...Array<CabinCode>(BOOKED_A).fill("A"),
    ...Array<CabinCode>(BOOKED_P).fill("P"),
    ...Array<CabinCode>(BOOKED_L).fill("L"),
  ];

  const bookings: ScenarioBookingSpec[] = cabinPlan.map((cabin, i) => {
    const index = i + 1;
    const given = GIVEN_NAMES[i % GIVEN_NAMES.length]!;
    const family = FAMILY_NAMES[i % FAMILY_NAMES.length]!;
    // ~40% of passengers carry an onward connection (2 of every 5).
    const hasConnection = i % 5 < 2;
    const onwardFlightNo = hasConnection ? (i % 2 === 0 ? "FL240" : "FL242") : null;

    const serviceTags: string[] = [];
    let loyaltyTier: string | null = null;
    if (cabin === "A" && i < 2) {
      serviceTags.push("vip");
      loyaltyTier = "invite";
    } else if (cabin === "P") {
      loyaltyTier = "gold";
    } else if (i % 6 === 0) {
      loyaltyTier = "silver";
    }
    if (hasConnection) {
      serviceTags.push("tight_connection");
    }
    if (i % 9 === 0) {
      serviceTags.push("service_recovery");
    }

    // A couple of bookings sit in the hold window to exercise the held-seat path.
    const status: ScenarioBookingSpec["status"] = index % 17 === 0 ? "awaiting_payment" : "confirmed";

    return {
      pnr: `DIS${String(index).padStart(3, "0")}`,
      sessionId: scenarioUuid(index),
      contact: {
        name: `${given} ${family}`,
        email: `${given}.${family}@example.com`.toLowerCase(),
        phone: `+1 312 555 ${String(1000 + index).padStart(4, "0")}`,
      },
      cabin,
      status,
      passenger: { givenName: given, familyName: family, loyaltyTier, serviceTags },
      hasConnection,
      onwardFlightNo,
      onwardCabin: hasConnection ? "L" : null,
    };
  });

  return {
    primaryFlightNo: PRIMARY_FLIGHT_NO,
    primaryDepartAt: primaryDepart,
    flights,
    bookings,
  };
}

function cabinMultiplier(code: CabinCode): number {
  const cabin = cabins.find((entry) => entry.code === code);
  return cabin ? Number(cabin.multiplier) : 1;
}

function fareForCabin(spec: ScenarioFlightSpec, cabin: CabinCode): {
  baseEur: number;
  taxesEur: number;
  surfaceEur: number;
} {
  const baseEur = Math.round(ROUTE_FARE_EUR[spec.routeKey] * cabinMultiplier(cabin) * spec.baseFactor);
  return { baseEur, taxesEur: Math.round(baseEur * 0.14), surfaceEur: 18 };
}

async function routeIdFor(
  tx: postgres.TransactionSql,
  fromIata: string,
  toIata: string,
): Promise<number> {
  const rows = (await tx`
    select id from public.routes where from_iata = ${fromIata} and to_iata = ${toIata}
  `) as unknown as Array<{ id: number }>;
  if (rows.length === 0) {
    throw new Error(`Disruption scenario requires route ${fromIata}-${toIata} in the catalog`);
  }
  return Number(rows[0]!.id);
}

async function insertScenarioFlight(
  tx: postgres.TransactionSql,
  spec: ScenarioFlightSpec,
  routeId: number,
): Promise<string> {
  const inserted = (await tx`
    insert into public.flights (
      flight_no, route_id, aircraft_type, depart_at, arrive_at, duration_min, status
    ) values (
      ${spec.flightNo}, ${routeId}, ${spec.aircraftType},
      ${spec.departAt.toISOString()}, ${spec.arriveAt.toISOString()},
      ${spec.durationMin}, 'scheduled'
    )
    on conflict (flight_no, depart_at) do update set
      route_id = excluded.route_id,
      aircraft_type = excluded.aircraft_type,
      arrive_at = excluded.arrive_at,
      duration_min = excluded.duration_min,
      status = 'scheduled',
      disrupted_at = null,
      disruption_reason = null
    returning id
  `) as unknown as Array<{ id: string }>;
  const flightId = inserted[0]!.id;

  const templates = seatTemplates.filter((template) => template.aircraftType === spec.aircraftType);
  for (const template of templates) {
    const cabin = template.cabin as CabinCode;
    const seats = flatSeats(template.rows);
    const fare = fareForCabin(spec, cabin);

    let taken = 0;
    for (const seat of seats) {
      // The primary flight starts empty; its seats are filled by the seeded
      // bookings. Non-primary flights carry a deterministic pre-existing load.
      const isTaken =
        spec.role !== "primary" && isSeatTaken(flightId, seat.seatId, cabin, spec.occupancy);
      if (isTaken) taken++;
      await tx`
        insert into public.flight_seats (flight_id, seat_id, cabin, zone, price_eur, status)
        values (${flightId}, ${seat.seatId}, ${cabin}, ${seat.zone}, ${seat.priceEur}, ${isTaken ? "taken" : "available"})
        on conflict (flight_id, seat_id) do update set
          zone = excluded.zone, price_eur = excluded.price_eur, status = excluded.status
      `;
    }

    await tx`
      insert into public.flight_fares (
        flight_id, cabin, base_eur, taxes_eur, surface_eur, seats_total, seats_available
      ) values (
        ${flightId}, ${cabin}, ${fare.baseEur}, ${fare.taxesEur}, ${fare.surfaceEur},
        ${seats.length}, ${Math.max(0, seats.length - taken)}
      )
      on conflict (flight_id, cabin) do update set
        base_eur = excluded.base_eur, taxes_eur = excluded.taxes_eur,
        surface_eur = excluded.surface_eur, seats_total = excluded.seats_total,
        seats_available = excluded.seats_available
    `;
  }

  return flightId;
}

async function recalcAvailability(tx: postgres.TransactionSql, flightId: string): Promise<void> {
  await tx`
    update public.flight_fares ff
    set seats_available = sub.available
    from (
      select cabin, count(*) filter (where status = 'available')::int as available
      from public.flight_seats
      where flight_id = ${flightId}
      group by cabin
    ) sub
    where ff.flight_id = ${flightId} and ff.cabin = sub.cabin
  `;
}

/**
 * Apply the deterministic FL228 disruption scenario. Idempotent and safe to run
 * on every reseed. Runs inside one transaction.
 */
export async function seedDisruptionScenario(
  sql: postgres.Sql,
  options: { baseDate: Date; now?: Date },
): Promise<void> {
  const plan = buildDisruptionPlan(options.baseDate, options.now ?? new Date());
  console.log(`[seed] disruption scenario - ${plan.primaryFlightNo} + ${plan.flights.length - 1} support flights`);

  await sql.begin(async (tx) => {
    const routeIds: Record<RouteKey, number> = {
      "LHR-ORD": await routeIdFor(tx, "LHR", "ORD"),
      "ORD-SFO": await routeIdFor(tx, "ORD", "SFO"),
    };

    const flightIdByNo = new Map<string, { id: string; spec: ScenarioFlightSpec }>();
    for (const spec of plan.flights) {
      const flightId = await insertScenarioFlight(tx, spec, routeIds[spec.routeKey]);
      flightIdByNo.set(spec.flightNo, { id: flightId, spec });
    }

    const primary = flightIdByNo.get(plan.primaryFlightNo)!;

    // Precompute the seat pool per cabin on the primary flight, assigning
    // sequentially so each booking gets a distinct, deterministic seat.
    const seatPool: Record<CabinCode, Array<{ seatId: string; priceEur: number }>> = {
      A: [], P: [], L: [],
    };
    for (const template of seatTemplates.filter((t) => t.aircraftType === primary.spec.aircraftType)) {
      seatPool[template.cabin as CabinCode] = flatSeats(template.rows).map((seat) => ({
        seatId: seat.seatId,
        priceEur: seat.priceEur,
      }));
    }
    const cursor: Record<CabinCode, number> = { A: 0, P: 0, L: 0 };

    for (const booking of plan.bookings) {
      const seat = seatPool[booking.cabin][cursor[booking.cabin]];
      cursor[booking.cabin] += 1;
      const seatId = seat?.seatId ?? null;
      const seatPrice = seat?.priceEur ?? 0;

      const segments: Array<{ flightId: string; cabin: CabinCode; spec: ScenarioFlightSpec }> = [
        { flightId: primary.id, cabin: booking.cabin, spec: primary.spec },
      ];
      if (booking.hasConnection && booking.onwardFlightNo && booking.onwardCabin) {
        const onward = flightIdByNo.get(booking.onwardFlightNo);
        if (onward) {
          segments.push({ flightId: onward.id, cabin: booking.onwardCabin, spec: onward.spec });
        }
      }

      const baseEur = segments.reduce((sum, seg) => sum + fareForCabin(seg.spec, seg.cabin).baseEur, 0);
      const taxesEur = segments.reduce((sum, seg) => sum + fareForCabin(seg.spec, seg.cabin).taxesEur, 0);
      const surfaceEur = segments.reduce((sum, seg) => sum + fareForCabin(seg.spec, seg.cabin).surfaceEur, 0);
      const totalEur = baseEur + taxesEur + surfaceEur + seatPrice;

      const confirmedAt = booking.status === "confirmed" ? primary.spec.departAt : null;
      const holdExpiresAt =
        booking.status === "awaiting_payment" ? addMinutes(options.now ?? new Date(), 30) : null;

      await tx`
        insert into public.bookings (
          pnr, session_id, status, contact, pax,
          base_eur, seats_eur, meals_eur, taxes_eur, surface_eur, total_eur,
          hold_expires_at, confirmed_at
        ) values (
          ${booking.pnr}, ${booking.sessionId}, ${booking.status}, ${tx.json(booking.contact)}, 1,
          ${baseEur}, ${seatPrice}, 0, ${taxesEur}, ${surfaceEur}, ${totalEur},
          ${holdExpiresAt?.toISOString() ?? null}, ${confirmedAt?.toISOString() ?? null}
        )
        on conflict (pnr) do nothing
      `;

      for (let s = 0; s < segments.length; s++) {
        await tx`
          insert into public.booking_segments (booking_pnr, flight_id, cabin, segment_no)
          values (${booking.pnr}, ${segments[s]!.flightId}, ${segments[s]!.cabin}, ${s + 1})
          on conflict (booking_pnr, segment_no) do update set
            flight_id = excluded.flight_id, cabin = excluded.cabin
        `;
      }

      await tx`
        insert into public.passengers (
          booking_pnr, passenger_no, given_name, family_name,
          loyalty_tier, service_tags, seat_id, meal_id
        ) values (
          ${booking.pnr}, 1, ${booking.passenger.givenName}, ${booking.passenger.familyName},
          ${booking.passenger.loyaltyTier}, ${booking.passenger.serviceTags},
          ${seatId}, null
        )
        on conflict (booking_pnr, passenger_no) do update set
          given_name = excluded.given_name, family_name = excluded.family_name,
          loyalty_tier = excluded.loyalty_tier, service_tags = excluded.service_tags,
          seat_id = excluded.seat_id
      `;

      if (seatId) {
        const seatStatus = booking.status === "confirmed" ? "taken" : "held";
        await tx`
          update public.flight_seats set status = ${seatStatus}
          where flight_id = ${primary.id} and seat_id = ${seatId}
        `;
        if (seatStatus === "held" && holdExpiresAt) {
          await tx`
            insert into public.seat_holds (flight_id, seat_id, session_id, expires_at)
            values (${primary.id}, ${seatId}, ${booking.sessionId}, ${holdExpiresAt.toISOString()})
            on conflict (flight_id, seat_id) do update set
              session_id = excluded.session_id, expires_at = excluded.expires_at
          `;
        }
      }
    }

    for (const { id } of flightIdByNo.values()) {
      await recalcAvailability(tx, id);
    }
  });

  console.log(`[seed] disruption scenario done - ${plan.bookings.length} bookings on ${plan.primaryFlightNo}`);
}
