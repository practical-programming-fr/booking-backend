// Ops disruption / recovery domain logic for the external FlyLo Ops Agent.
//
// These operations are ops-shaped (they act on a whole flight and its booked
// passengers), unlike the booking flow which is create/search-shaped. They
// reuse the booking domain primitives (seat status, fare counters, totals
// recompute, booking_events) so seat_holds, inventory counters, and totals
// stay consistent with the rest of the system. No table is written directly
// that the booking flow does not already own.
//
// Everything here is designed to be idempotent so the agent can safely re-run
// or double-approve an action:
//   * cancelFlight       keys off the flight status transition.
//   * rebookPassenger    keys off (pnr, fromSegmentId, toFlightId) via the
//                        ops_rebookings ledger.

import type postgres from "postgres";
import { DomainError, HOLD_MINUTES } from "./booking.js";
import { recomputeBookingTotals } from "./totals.js";
import type { CabinCode, ContactDetails } from "./types.js";

const ACTIVE_BOOKING_STATUSES = ["confirmed", "awaiting_payment"] as const;

export type FlightRef = {
  id: string;
  flightNo: string;
  routeId: number;
  aircraftType: string;
  departAt: string;
  arriveAt: string;
  durationMin: number;
  status: string;
  disruptedAt: string | null;
  disruptionReason: string | null;
  from: { iata: string; city: string };
  to: { iata: string; city: string };
};

export type FlightSelector = {
  flightId?: string;
  flightNo?: string;
  departDate?: string;
};

type FlightRow = {
  id: string;
  flight_no: string;
  route_id: number;
  aircraft_type: string;
  depart_at: Date;
  arrive_at: Date;
  duration_min: number;
  status: string;
  disrupted_at: Date | null;
  disruption_reason: string | null;
  from_iata: string;
  from_city: string;
  to_iata: string;
  to_city: string;
};

function toFlightRef(row: FlightRow): FlightRef {
  return {
    id: row.id,
    flightNo: row.flight_no,
    routeId: row.route_id,
    aircraftType: row.aircraft_type,
    departAt: row.depart_at.toISOString(),
    arriveAt: row.arrive_at.toISOString(),
    durationMin: row.duration_min,
    status: row.status,
    disruptedAt: row.disrupted_at?.toISOString() ?? null,
    disruptionReason: row.disruption_reason,
    from: { iata: row.from_iata, city: row.from_city },
    to: { iata: row.to_iata, city: row.to_city },
  };
}

/**
 * Resolve a single flight from a selector. Prefers an explicit flightId, then
 * flight_no plus an optional departDate. When a flight_no matches more than one
 * dated departure and no date is given, the soonest upcoming departure wins
 * (falling back to the most recent past one), so the agent can pass just a
 * flight number for the common "today" case.
 */
export async function resolveFlight(
  sql: postgres.Sql,
  selector: FlightSelector,
): Promise<FlightRef | null> {
  if (selector.flightId) {
    const rows = (await sql`
      select f.id, f.flight_no, f.route_id, f.aircraft_type,
             f.depart_at, f.arrive_at, f.duration_min, f.status,
             f.disrupted_at, f.disruption_reason,
             r.from_iata, fa.city as from_city, r.to_iata, ta.city as to_city
      from public.flights f
      join public.routes r on r.id = f.route_id
      join public.airports fa on fa.iata = r.from_iata
      join public.airports ta on ta.iata = r.to_iata
      where f.id = ${selector.flightId}
    `) as unknown as FlightRow[];
    return rows[0] ? toFlightRef(rows[0]) : null;
  }

  if (!selector.flightNo) {
    return null;
  }
  const flightNo = selector.flightNo.toUpperCase();

  let rows: FlightRow[];
  if (selector.departDate) {
    const dayStart = new Date(`${selector.departDate}T00:00:00Z`);
    const dayEnd = new Date(`${selector.departDate}T23:59:59.999Z`);
    rows = (await sql`
      select f.id, f.flight_no, f.route_id, f.aircraft_type,
             f.depart_at, f.arrive_at, f.duration_min, f.status,
             f.disrupted_at, f.disruption_reason,
             r.from_iata, fa.city as from_city, r.to_iata, ta.city as to_city
      from public.flights f
      join public.routes r on r.id = f.route_id
      join public.airports fa on fa.iata = r.from_iata
      join public.airports ta on ta.iata = r.to_iata
      where f.flight_no = ${flightNo}
        and f.depart_at >= ${dayStart.toISOString()}::timestamptz
        and f.depart_at <= ${dayEnd.toISOString()}::timestamptz
      order by f.depart_at asc
    `) as unknown as FlightRow[];
  } else {
    rows = (await sql`
      select f.id, f.flight_no, f.route_id, f.aircraft_type,
             f.depart_at, f.arrive_at, f.duration_min, f.status,
             f.disrupted_at, f.disruption_reason,
             r.from_iata, fa.city as from_city, r.to_iata, ta.city as to_city
      from public.flights f
      join public.routes r on r.id = f.route_id
      join public.airports fa on fa.iata = r.from_iata
      join public.airports ta on ta.iata = r.to_iata
      where f.flight_no = ${flightNo}
      order by f.depart_at asc
    `) as unknown as FlightRow[];
  }

  if (rows.length === 0) {
    return null;
  }
  const now = Date.now();
  const upcoming = rows.find((row) => row.depart_at.getTime() >= now);
  return toFlightRef(upcoming ?? rows[rows.length - 1]!);
}

// --- Passengers on a flight ------------------------------------------------

export type OnwardConnection = {
  segmentId: number;
  segmentNo: number;
  flightId: string;
  flightNo: string;
  cabin: CabinCode;
  departAt: string;
  arriveAt: string;
  from: { iata: string; city: string };
  to: { iata: string; city: string };
};

export type AffectedPassenger = {
  pnr: string;
  bookingStatus: string;
  segmentId: number;
  segmentNo: number;
  cabin: CabinCode;
  passengerId: number;
  passengerNo: number;
  givenName: string;
  familyName: string;
  seatId: string | null;
  loyaltyTier: string | null;
  serviceTags: string[];
  contact: ContactDetails;
  hasConnection: boolean;
  onwardConnection: OnwardConnection | null;
};

type PassengerRow = {
  segment_id: number;
  segment_no: number;
  cabin: CabinCode;
  pnr: string;
  booking_status: string;
  contact: ContactDetails | null;
  passenger_id: number;
  passenger_no: number;
  given_name: string;
  family_name: string;
  seat_id: string | null;
  loyalty_tier: string | null;
  service_tags: string[] | null;
};

type OnwardRow = {
  booking_pnr: string;
  segment_id: number;
  segment_no: number;
  cabin: CabinCode;
  flight_id: string;
  flight_no: string;
  depart_at: Date;
  arrive_at: Date;
  from_iata: string;
  from_city: string;
  to_iata: string;
  to_city: string;
};

/**
 * List the booked passengers on a flight, with contact info and (when the
 * booking continues past this leg) the next onward connecting segment so the
 * agent can reason about misconnects. Mirrors the manifest domain query shape
 * but adds contact + connection data the manifest does not carry.
 */
export async function listFlightPassengers(
  sql: postgres.Sql,
  flightId: string,
): Promise<AffectedPassenger[]> {
  const rows = (await sql`
    select bs.id as segment_id, bs.segment_no, bs.cabin,
           b.pnr, b.status as booking_status, b.contact,
           p.id as passenger_id, p.passenger_no, p.given_name, p.family_name,
           p.seat_id, p.loyalty_tier, p.service_tags
    from public.booking_segments bs
    join public.bookings b on b.pnr = bs.booking_pnr
    join public.passengers p on p.booking_pnr = b.pnr
    where bs.flight_id = ${flightId}
      and b.status in ${sql(ACTIVE_BOOKING_STATUSES as unknown as string[])}
    order by bs.cabin, p.passenger_no
  `) as unknown as PassengerRow[];

  if (rows.length === 0) {
    return [];
  }

  const pnrs = [...new Set(rows.map((row) => row.pnr))];
  const onwardRows = (await sql`
    select bs.booking_pnr, bs.id as segment_id, bs.segment_no, bs.cabin,
           f.id as flight_id, f.flight_no, f.depart_at, f.arrive_at,
           r.from_iata, fa.city as from_city, r.to_iata, ta.city as to_city
    from public.booking_segments bs
    join public.flights f on f.id = bs.flight_id
    join public.routes r on r.id = f.route_id
    join public.airports fa on fa.iata = r.from_iata
    join public.airports ta on ta.iata = r.to_iata
    where bs.booking_pnr in ${sql(pnrs)}
    order by bs.booking_pnr, bs.segment_no asc
  `) as unknown as OnwardRow[];

  const onwardByPnr = new Map<string, OnwardRow[]>();
  for (const row of onwardRows) {
    const list = onwardByPnr.get(row.booking_pnr) ?? [];
    list.push(row);
    onwardByPnr.set(row.booking_pnr, list);
  }

  return rows.map((row) => {
    const onward = (onwardByPnr.get(row.pnr) ?? []).find(
      (segment) => segment.segment_no > row.segment_no,
    );
    return {
      pnr: row.pnr,
      bookingStatus: row.booking_status,
      segmentId: Number(row.segment_id),
      segmentNo: row.segment_no,
      cabin: row.cabin,
      passengerId: Number(row.passenger_id),
      passengerNo: row.passenger_no,
      givenName: row.given_name,
      familyName: row.family_name,
      seatId: row.seat_id,
      loyaltyTier: row.loyalty_tier,
      serviceTags: row.service_tags ?? [],
      contact: row.contact ?? {},
      hasConnection: Boolean(onward),
      onwardConnection: onward
        ? {
            segmentId: Number(onward.segment_id),
            segmentNo: onward.segment_no,
            flightId: onward.flight_id,
            flightNo: onward.flight_no,
            cabin: onward.cabin,
            departAt: onward.depart_at.toISOString(),
            arriveAt: onward.arrive_at.toISOString(),
            from: { iata: onward.from_iata, city: onward.from_city },
            to: { iata: onward.to_iata, city: onward.to_city },
          }
        : null,
    };
  });
}

// --- Cancel a flight -------------------------------------------------------

export type CancelFlightResult = {
  flight: FlightRef;
  alreadyCancelled: boolean;
  affected: {
    bookings: number;
    passengers: number;
    withConnections: number;
  };
  passengers: AffectedPassenger[];
};

export async function cancelFlight(
  sql: postgres.Sql,
  flight: FlightRef,
  options: { reason?: string | null; actor?: string } = {},
): Promise<CancelFlightResult> {
  const passengers = await listFlightPassengers(sql, flight.id);
  const reason = options.reason ?? "flight cancelled by operations";
  const actor = options.actor ?? "ops_agent";

  const updated = (await sql`
    update public.flights
    set status = 'cancelled',
        disrupted_at = coalesce(disrupted_at, now()),
        disruption_reason = coalesce(disruption_reason, ${reason})
    where id = ${flight.id} and status <> 'cancelled'
    returning id
  `) as unknown as Array<{ id: string }>;

  const alreadyCancelled = updated.length === 0;

  // Record one disruption event per affected booking, but only on the first
  // cancellation so re-running the endpoint stays idempotent (no duplicate
  // events, no error).
  if (!alreadyCancelled) {
    const pnrs = [...new Set(passengers.map((passenger) => passenger.pnr))];
    for (const pnr of pnrs) {
      await sql`
        insert into public.booking_events (booking_pnr, event_type, actor, details)
        values (
          ${pnr}, 'flight_disrupted', ${actor},
          ${sql.json({
            kind: "cancellation",
            flightId: flight.id,
            flightNo: flight.flightNo,
            from: flight.from.iata,
            to: flight.to.iata,
            reason,
          })}
        )
      `;
    }
  }

  const refreshed = await resolveFlight(sql, { flightId: flight.id });

  return {
    flight: refreshed ?? { ...flight, status: "cancelled" },
    alreadyCancelled,
    affected: {
      bookings: new Set(passengers.map((passenger) => passenger.pnr)).size,
      passengers: passengers.length,
      withConnections: passengers.filter((passenger) => passenger.hasConnection).length,
    },
    passengers,
  };
}

// --- Alternatives ----------------------------------------------------------

export type AlternativeFare = {
  cabin: CabinCode;
  baseEur: number;
  seatsAvailable: number;
  fareDiffEur: number | null;
};

export type AlternativeFlight = {
  flightId: string;
  flightNo: string;
  status: string;
  departAt: string;
  arriveAt: string;
  durationMin: number;
  aircraftType: string;
  from: { iata: string; city: string };
  to: { iata: string; city: string };
  seatsAvailableTotal: number;
  fares: AlternativeFare[];
};

type AlternativeRow = {
  id: string;
  flight_no: string;
  status: string;
  depart_at: Date;
  arrive_at: Date;
  duration_min: number;
  aircraft_type: string;
  cabin: CabinCode;
  base_eur: number;
  seats_available: number;
};

/**
 * Candidate flights the affected passengers could be rebooked onto: same
 * origin-destination as the disrupted flight, departing within a near-term
 * window (default same day plus the next day), with per-cabin availability and
 * the fare difference versus the original flight. This is the ranking input the
 * agent reasons over; it does not itself pick a winner.
 */
export async function listAlternatives(
  sql: postgres.Sql,
  flight: FlightRef,
  options: { windowDays?: number } = {},
): Promise<AlternativeFlight[]> {
  const windowDays = options.windowDays ?? 1;
  const departDay = new Date(flight.departAt);
  const windowStart = new Date(departDay);
  windowStart.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + windowDays + 1);

  // Only future departures are useful to rebook into. We compare against the
  // window start (not now) for the range, then drop anything already departed.
  const nowIso = new Date().toISOString();

  const rows = (await sql`
    select f.id, f.flight_no, f.status, f.depart_at, f.arrive_at,
           f.duration_min, f.aircraft_type,
           ff.cabin, ff.base_eur, ff.seats_available
    from public.flights f
    join public.flight_fares ff on ff.flight_id = f.id
    where f.route_id = ${flight.routeId}
      and f.id <> ${flight.id}
      and f.status <> 'cancelled'
      and f.depart_at >= ${windowStart.toISOString()}::timestamptz
      and f.depart_at < ${windowEnd.toISOString()}::timestamptz
      and f.depart_at >= ${nowIso}::timestamptz
    order by f.depart_at asc, ff.cabin asc
  `) as unknown as AlternativeRow[];

  const originalFares = (await sql`
    select cabin, base_eur from public.flight_fares where flight_id = ${flight.id}
  `) as unknown as Array<{ cabin: CabinCode; base_eur: number }>;
  const originalBaseByCabin = new Map(originalFares.map((row) => [row.cabin, row.base_eur]));

  const byFlight = new Map<string, AlternativeFlight>();
  for (const row of rows) {
    let entry = byFlight.get(row.id);
    if (!entry) {
      entry = {
        flightId: row.id,
        flightNo: row.flight_no,
        status: row.status,
        departAt: row.depart_at.toISOString(),
        arriveAt: row.arrive_at.toISOString(),
        durationMin: row.duration_min,
        aircraftType: row.aircraft_type,
        from: flight.from,
        to: flight.to,
        seatsAvailableTotal: 0,
        fares: [],
      };
      byFlight.set(row.id, entry);
    }
    const originalBase = originalBaseByCabin.get(row.cabin);
    entry.fares.push({
      cabin: row.cabin,
      baseEur: row.base_eur,
      seatsAvailable: row.seats_available,
      fareDiffEur: originalBase != null ? row.base_eur - originalBase : null,
    });
    entry.seatsAvailableTotal += row.seats_available;
  }

  return [...byFlight.values()];
}

// --- Rebook one booking segment onto a new flight --------------------------

export type RebookInput = {
  pnr: string;
  passengerId?: number;
  fromSegmentId: number;
  toFlightId?: string;
  toFlightNo?: string;
  toDate?: string;
  cabin?: CabinCode;
  actor?: string;
};

export type RebookedItinerary = {
  pnr: string;
  passengerId: number | null;
  passengerName: string | null;
  fromSegmentId: number;
  fromFlightId: string;
  cabin: CabinCode;
  seatId: string | null;
  flight: {
    flightId: string;
    flightNo: string;
    departAt: string;
    arriveAt: string;
    durationMin: number;
    from: { iata: string; city: string };
    to: { iata: string; city: string };
  };
  fareDeltaEur: number;
  totalEur: number;
};

export type RebookResult = {
  alreadyRebooked: boolean;
  itinerary: RebookedItinerary;
};

async function buildItinerary(
  sql: postgres.Sql,
  pnr: string,
  segmentId: number,
  passengerId: number | null,
  fareDeltaEur: number,
): Promise<RebookedItinerary> {
  const segmentRows = (await sql`
    select bs.id as segment_id, bs.cabin, bs.flight_id,
           f.flight_no, f.depart_at, f.arrive_at, f.duration_min,
           r.from_iata, fa.city as from_city, r.to_iata, ta.city as to_city
    from public.booking_segments bs
    join public.flights f on f.id = bs.flight_id
    join public.routes r on r.id = f.route_id
    join public.airports fa on fa.iata = r.from_iata
    join public.airports ta on ta.iata = r.to_iata
    where bs.id = ${segmentId}
  `) as unknown as Array<{
    segment_id: number;
    cabin: CabinCode;
    flight_id: string;
    flight_no: string;
    depart_at: Date;
    arrive_at: Date;
    duration_min: number;
    from_iata: string;
    from_city: string;
    to_iata: string;
    to_city: string;
  }>;
  const segment = segmentRows[0]!;

  const passengerRows =
    passengerId != null
      ? ((await sql`
          select id, given_name, family_name, seat_id
          from public.passengers
          where booking_pnr = ${pnr} and id = ${passengerId}
        `) as unknown as Array<{
          id: number;
          given_name: string;
          family_name: string;
          seat_id: string | null;
        }>)
      : [];
  const passenger = passengerRows[0];

  const totalsRows = (await sql`
    select total_eur from public.bookings where pnr = ${pnr}
  `) as unknown as Array<{ total_eur: number }>;

  return {
    pnr,
    passengerId: passenger ? Number(passenger.id) : passengerId ?? null,
    passengerName: passenger ? `${passenger.given_name} ${passenger.family_name}` : null,
    fromSegmentId: Number(segment.segment_id),
    fromFlightId: segment.flight_id,
    cabin: segment.cabin,
    seatId: passenger?.seat_id ?? null,
    flight: {
      flightId: segment.flight_id,
      flightNo: segment.flight_no,
      departAt: segment.depart_at.toISOString(),
      arriveAt: segment.arrive_at.toISOString(),
      durationMin: segment.duration_min,
      from: { iata: segment.from_iata, city: segment.from_city },
      to: { iata: segment.to_iata, city: segment.to_city },
    },
    fareDeltaEur,
    totalEur: totalsRows[0]?.total_eur ?? 0,
  };
}

export async function rebookPassenger(
  sql: postgres.Sql,
  input: RebookInput,
): Promise<RebookResult> {
  const actor = input.actor ?? "ops_agent";

  // Resolve the target flight up front (read-only).
  const target = await resolveFlight(sql, {
    flightId: input.toFlightId,
    flightNo: input.toFlightNo,
    departDate: input.toDate,
  });
  if (!target) {
    throw new DomainError(404, "Target flight not found", "target_flight_not_found");
  }

  // Idempotency short-circuit: if this exact move is already recorded, return
  // the current itinerary without touching anything.
  const existing = (await sql`
    select id, passenger_id, to_segment_id, fare_delta_eur
    from public.ops_rebookings
    where pnr = ${input.pnr}
      and from_segment_id = ${input.fromSegmentId}
      and to_flight_id = ${target.id}
  `) as unknown as Array<{
    id: number;
    passenger_id: number | null;
    to_segment_id: number | null;
    fare_delta_eur: number;
  }>;
  if (existing.length > 0) {
    const row = existing[0]!;
    const itinerary = await buildItinerary(
      sql,
      input.pnr,
      row.to_segment_id ?? input.fromSegmentId,
      row.passenger_id ?? input.passengerId ?? null,
      row.fare_delta_eur,
    );
    return { alreadyRebooked: true, itinerary };
  }

  const result = await sql.begin(async (tx) => {
    const bookingRows = (await tx`
      select pnr, session_id, status, total_eur
      from public.bookings
      where pnr = ${input.pnr}
      for update
    `) as unknown as Array<{
      pnr: string;
      session_id: string;
      status: string;
      total_eur: number;
    }>;
    if (bookingRows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const booking = bookingRows[0]!;
    if (booking.status === "cancelled") {
      throw new DomainError(409, "Booking has been cancelled", "booking_cancelled");
    }

    const segmentRows = (await tx`
      select id, flight_id, cabin, segment_no
      from public.booking_segments
      where id = ${input.fromSegmentId} and booking_pnr = ${input.pnr}
      for update
    `) as unknown as Array<{
      id: number;
      flight_id: string;
      cabin: CabinCode;
      segment_no: number;
    }>;
    if (segmentRows.length === 0) {
      throw new DomainError(
        404,
        "Segment not found on this booking",
        "segment_not_found",
      );
    }
    const segment = segmentRows[0]!;
    const oldFlightId = segment.flight_id;
    const targetCabin: CabinCode = input.cabin ?? segment.cabin;

    if (oldFlightId === target.id && segment.cabin === targetCabin) {
      throw new DomainError(
        409,
        "Segment is already on the target flight and cabin",
        "rebook_noop",
      );
    }

    // Reserve the idempotency ledger row first. If a concurrent request already
    // claimed this move, do-nothing returns no row and we abort without
    // mutating anything; the caller then reads the winning result.
    const claimed = (await tx`
      insert into public.ops_rebookings (
        pnr, passenger_id, from_segment_id, from_flight_id, to_flight_id,
        to_segment_id, cabin
      ) values (
        ${input.pnr}, ${input.passengerId ?? null}, ${input.fromSegmentId},
        ${oldFlightId}, ${target.id}, ${input.fromSegmentId}, ${targetCabin}
      )
      on conflict (pnr, from_segment_id, to_flight_id) do nothing
      returning id
    `) as unknown as Array<{ id: number }>;
    if (claimed.length === 0) {
      return { raced: true as const };
    }
    const ledgerId = claimed[0]!.id;

    if (target.status === "cancelled") {
      throw new DomainError(409, "Target flight is cancelled", "target_flight_cancelled");
    }
    if (new Date(target.departAt).getTime() <= Date.now()) {
      throw new DomainError(409, "Target flight has already departed", "target_flight_departed");
    }

    const fareRows = (await tx`
      select seats_available from public.flight_fares
      where flight_id = ${target.id} and cabin = ${targetCabin}
      for update
    `) as unknown as Array<{ seats_available: number }>;
    if (fareRows.length === 0) {
      throw new DomainError(
        422,
        `Cabin ${targetCabin} is not offered on the target flight`,
        "target_cabin_not_offered",
      );
    }

    const passengerRows = (await tx`
      select id, passenger_no, seat_id
      from public.passengers
      where booking_pnr = ${input.pnr}
      order by passenger_no asc
    `) as unknown as Array<{ id: number; passenger_no: number; seat_id: string | null }>;
    if (input.passengerId != null && !passengerRows.some((p) => Number(p.id) === input.passengerId)) {
      throw new DomainError(
        422,
        "passengerId does not belong to this booking",
        "passenger_not_on_booking",
      );
    }
    const pax = passengerRows.length;

    if (fareRows[0]!.seats_available < pax) {
      throw new DomainError(
        409,
        `Only ${fareRows[0]!.seats_available} ${targetCabin} seats remain on the target flight`,
        "insufficient_inventory",
      );
    }

    const availableSeats = (await tx`
      select seat_id, price_eur from public.flight_seats
      where flight_id = ${target.id} and cabin = ${targetCabin} and status = 'available'
      order by seat_id asc
      limit ${pax}
      for update
    `) as unknown as Array<{ seat_id: string; price_eur: number }>;
    if (availableSeats.length < pax) {
      throw new DomainError(
        409,
        "Not enough available seats on the target flight",
        "insufficient_seats",
      );
    }

    // Release the seats this booking held on the OLD flight and restore its
    // cabin inventory counter. Only the disrupted leg is touched; onward
    // segments keep their seats.
    const oldSeatIds = passengerRows
      .map((p) => p.seat_id)
      .filter((seatId): seatId is string => Boolean(seatId));
    if (oldSeatIds.length > 0) {
      await tx`
        update public.flight_seats
        set status = 'available'
        where flight_id = ${oldFlightId}
          and seat_id in ${tx(oldSeatIds)}
          and status in ('held', 'taken')
      `;
      await tx`
        delete from public.seat_holds
        where flight_id = ${oldFlightId} and seat_id in ${tx(oldSeatIds)}
      `;
    }
    await tx`
      update public.flight_fares
      set seats_available = seats_available + ${pax}
      where flight_id = ${oldFlightId} and cabin = ${segment.cabin}
    `;

    // Move the segment onto the target flight + cabin.
    await tx`
      update public.booking_segments
      set flight_id = ${target.id}, cabin = ${targetCabin}
      where id = ${input.fromSegmentId}
    `;

    // Assign the new seats. Confirmed bookings take the seat outright; anything
    // still in the hold window gets a fresh hold tied to the booking session.
    const seatStatus = booking.status === "confirmed" ? "taken" : "held";
    const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString();
    let reportSeatId: string | null = null;
    for (let i = 0; i < passengerRows.length; i++) {
      const passenger = passengerRows[i]!;
      const seat = availableSeats[i]!;
      await tx`
        update public.flight_seats
        set status = ${seatStatus}
        where flight_id = ${target.id} and seat_id = ${seat.seat_id}
      `;
      if (seatStatus === "held") {
        await tx`
          insert into public.seat_holds (flight_id, seat_id, session_id, expires_at)
          values (${target.id}, ${seat.seat_id}, ${booking.session_id}, ${holdExpiresAt})
          on conflict (flight_id, seat_id) do update set
            session_id = excluded.session_id,
            expires_at = excluded.expires_at
        `;
      }
      await tx`
        update public.passengers
        set seat_id = ${seat.seat_id}
        where id = ${passenger.id}
      `;
      if (input.passengerId != null && Number(passenger.id) === input.passengerId) {
        reportSeatId = seat.seat_id;
      }
    }
    if (reportSeatId === null && availableSeats.length > 0) {
      reportSeatId = availableSeats[0]!.seat_id;
    }

    await tx`
      update public.flight_fares
      set seats_available = seats_available - ${pax}
      where flight_id = ${target.id} and cabin = ${targetCabin}
    `;

    // Recompute totals from the moved segment's fares (reuses totals.ts). Safe
    // to run inside the transaction: it only issues tagged-template reads and
    // writes to the same booking row.
    const newTotals = await recomputeBookingTotals(
      tx as unknown as postgres.Sql,
      input.pnr,
    );
    const fareDeltaEur = newTotals.totalEur - booking.total_eur;

    await tx`
      update public.ops_rebookings
      set seat_id = ${reportSeatId}, fare_delta_eur = ${fareDeltaEur}
      where id = ${ledgerId}
    `;

    await tx`
      insert into public.booking_events (booking_pnr, event_type, actor, details)
      values (
        ${input.pnr}, 'rebooked_from', ${actor},
        ${tx.json({
          fromFlightId: oldFlightId,
          fromSegmentId: input.fromSegmentId,
          reason: "flight disruption",
        })}
      )
    `;
    await tx`
      insert into public.booking_events (booking_pnr, event_type, actor, details)
      values (
        ${input.pnr}, 'rebooked_to', ${actor},
        ${tx.json({
          toFlightId: target.id,
          toFlightNo: target.flightNo,
          cabin: targetCabin,
          fareDeltaEur,
        })}
      )
    `;

    return { raced: false as const, fareDeltaEur };
  });

  if (result.raced) {
    const row = (await sql`
      select passenger_id, to_segment_id, fare_delta_eur
      from public.ops_rebookings
      where pnr = ${input.pnr}
        and from_segment_id = ${input.fromSegmentId}
        and to_flight_id = ${target.id}
    `) as unknown as Array<{
      passenger_id: number | null;
      to_segment_id: number | null;
      fare_delta_eur: number;
    }>;
    const winning = row[0];
    const itinerary = await buildItinerary(
      sql,
      input.pnr,
      winning?.to_segment_id ?? input.fromSegmentId,
      winning?.passenger_id ?? input.passengerId ?? null,
      winning?.fare_delta_eur ?? 0,
    );
    return { alreadyRebooked: true, itinerary };
  }

  const itinerary = await buildItinerary(
    sql,
    input.pnr,
    input.fromSegmentId,
    input.passengerId ?? null,
    result.fareDeltaEur,
  );
  return { alreadyRebooked: false, itinerary };
}
