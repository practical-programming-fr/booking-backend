// Disruption domain tests. Following the repo convention (see ops.test.ts and
// demo-sessions.test.ts) these run against a small in-memory fake of the
// postgres.js tagged-template client rather than a live database. The fake here
// is a little larger because it models a handful of related tables so the
// rebook flow (seat move + fare counters + totals recompute + idempotency
// ledger) can be exercised end to end. Unhandled queries throw so the fake
// stays honest.

import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  cancelFlight,
  listAlternatives,
  listFlightPassengers,
  rebookPassenger,
  resolveFlight,
} from "../src/domain/disruption.js";

type Row = Record<string, unknown>;

const paramMarker = Symbol("param");
const jsonMarker = Symbol("json");
type Wrapped = { [paramMarker]?: unknown; [jsonMarker]?: unknown };

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object") {
    const wrapped = value as Wrapped;
    if (paramMarker in wrapped) return wrapped[paramMarker];
    if (jsonMarker in wrapped) return wrapped[jsonMarker];
  }
  return value;
}

type Db = {
  airports: Array<{ iata: string; city: string }>;
  routes: Array<{ id: number; from_iata: string; to_iata: string }>;
  flights: Array<Row>;
  flight_fares: Array<Row>;
  flight_seats: Array<Row>;
  seat_holds: Array<Row>;
  bookings: Array<Row>;
  booking_segments: Array<Row>;
  passengers: Array<Row>;
  booking_events: Array<Row>;
  ops_rebookings: Array<Row>;
};

function airportCity(db: Db, iata: string): string {
  return db.airports.find((a) => a.iata === iata)?.city ?? "";
}

function flightJoinRow(db: Db, flight: Row): Row {
  const route = db.routes.find((r) => r.id === flight.route_id)!;
  return {
    ...flight,
    from_iata: route.from_iata,
    from_city: airportCity(db, route.from_iata),
    to_iata: route.to_iata,
    to_city: airportCity(db, route.to_iata),
  };
}

function makeSql(db: Db): postgres.Sql {
  let rebookSeq = 100;

  function dispatch(text: string, rawValues: unknown[]): Row[] {
    const v = rawValues.map(unwrap);

    // --- resolveFlight -----------------------------------------------------
    if (text.includes("from public.flights f") && text.includes("where f.id = ?") && text.includes("f.disrupted_at")) {
      const flight = db.flights.find((f) => f.id === v[0]);
      return flight ? [flightJoinRow(db, flight)] : [];
    }
    if (text.includes("where f.flight_no = ?") && text.includes("and f.depart_at <= ?")) {
      const [flightNo, startIso, endIso] = v as [string, string, string];
      return db.flights
        .filter(
          (f) =>
            f.flight_no === flightNo &&
            (f.depart_at as Date).toISOString() >= startIso &&
            (f.depart_at as Date).toISOString() <= endIso,
        )
        .sort((a, b) => (a.depart_at as Date).getTime() - (b.depart_at as Date).getTime())
        .map((f) => flightJoinRow(db, f));
    }
    if (text.includes("where f.flight_no = ?") && text.includes("order by f.depart_at asc")) {
      const [flightNo] = v as [string];
      return db.flights
        .filter((f) => f.flight_no === flightNo)
        .sort((a, b) => (a.depart_at as Date).getTime() - (b.depart_at as Date).getTime())
        .map((f) => flightJoinRow(db, f));
    }

    // --- listFlightPassengers ---------------------------------------------
    if (
      text.includes("from public.booking_segments bs") &&
      text.includes("join public.passengers p") &&
      text.includes("where bs.flight_id = ?")
    ) {
      const [flightId, statuses] = [v[0], v[1] as string[]];
      const out: Row[] = [];
      for (const seg of db.booking_segments.filter((s) => s.flight_id === flightId)) {
        const booking = db.bookings.find((b) => b.pnr === seg.booking_pnr)!;
        if (!statuses.includes(booking.status as string)) continue;
        for (const p of db.passengers.filter((pp) => pp.booking_pnr === seg.booking_pnr)) {
          out.push({
            segment_id: seg.id,
            segment_no: seg.segment_no,
            cabin: seg.cabin,
            pnr: booking.pnr,
            booking_status: booking.status,
            contact: booking.contact,
            passenger_id: p.id,
            passenger_no: p.passenger_no,
            given_name: p.given_name,
            family_name: p.family_name,
            seat_id: p.seat_id,
            loyalty_tier: p.loyalty_tier,
            service_tags: p.service_tags,
          });
        }
      }
      return out;
    }
    if (
      text.includes("from public.booking_segments bs") &&
      text.includes("join public.flights f") &&
      text.includes("where bs.booking_pnr in")
    ) {
      const pnrs = v[0] as string[];
      const out: Row[] = [];
      for (const seg of db.booking_segments.filter((s) => pnrs.includes(s.booking_pnr as string))) {
        const flight = db.flights.find((f) => f.id === seg.flight_id)!;
        const joined = flightJoinRow(db, flight);
        out.push({
          booking_pnr: seg.booking_pnr,
          segment_id: seg.id,
          segment_no: seg.segment_no,
          cabin: seg.cabin,
          flight_id: flight.id,
          flight_no: flight.flight_no,
          depart_at: flight.depart_at,
          arrive_at: flight.arrive_at,
          from_iata: joined.from_iata,
          from_city: joined.from_city,
          to_iata: joined.to_iata,
          to_city: joined.to_city,
        });
      }
      return out.sort((a, b) => (a.segment_no as number) - (b.segment_no as number));
    }

    // --- cancelFlight ------------------------------------------------------
    if (text.includes("update public.flights") && text.includes("set status = 'cancelled'")) {
      const [reason, flightId] = v as [string, string];
      const flight = db.flights.find((f) => f.id === flightId)!;
      if (flight.status === "cancelled") return [];
      flight.status = "cancelled";
      flight.disrupted_at = new Date();
      flight.disruption_reason = reason;
      return [{ id: flight.id }];
    }

    // --- booking_events insert (cancel + rebook) --------------------------
    if (text.includes("insert into public.booking_events")) {
      db.booking_events.push({ booking_pnr: v[0], actor: v[1], details: v[2] });
      return [];
    }

    // --- listAlternatives --------------------------------------------------
    if (text.includes("join public.flight_fares ff") && text.includes("where f.route_id = ?")) {
      const [routeId, excludeId, startIso, endIso, nowIso] = v as [number, string, string, string, string];
      const out: Row[] = [];
      for (const flight of db.flights) {
        if (flight.route_id !== routeId) continue;
        if (flight.id === excludeId) continue;
        if (flight.status === "cancelled") continue;
        const dep = (flight.depart_at as Date).toISOString();
        if (!(dep >= startIso && dep < endIso && dep >= nowIso)) continue;
        for (const fare of db.flight_fares.filter((ff) => ff.flight_id === flight.id)) {
          out.push({
            id: flight.id,
            flight_no: flight.flight_no,
            status: flight.status,
            depart_at: flight.depart_at,
            arrive_at: flight.arrive_at,
            duration_min: flight.duration_min,
            aircraft_type: flight.aircraft_type,
            cabin: fare.cabin,
            base_eur: fare.base_eur,
            seats_available: fare.seats_available,
          });
        }
      }
      return out.sort((a, b) => (a.depart_at as Date).getTime() - (b.depart_at as Date).getTime());
    }
    if (text.includes("select cabin, base_eur from public.flight_fares where flight_id = ?")) {
      const [flightId] = v as [string];
      return db.flight_fares
        .filter((ff) => ff.flight_id === flightId)
        .map((ff) => ({ cabin: ff.cabin, base_eur: ff.base_eur }));
    }

    // --- ops_rebookings select (idempotency short-circuit + race re-read) --
    if (
      text.includes("from public.ops_rebookings") &&
      text.includes("where pnr = ?") &&
      text.includes("to_flight_id = ?")
    ) {
      const [pnr, fromSegmentId, toFlightId] = v as [string, number, string];
      return db.ops_rebookings.filter(
        (r) => r.pnr === pnr && r.from_segment_id === fromSegmentId && r.to_flight_id === toFlightId,
      );
    }

    // --- buildItinerary ----------------------------------------------------
    if (
      text.includes("from public.booking_segments bs") &&
      text.includes("join public.flights f") &&
      text.includes("where bs.id = ?")
    ) {
      const [segmentId] = v as [number];
      const seg = db.booking_segments.find((s) => s.id === segmentId)!;
      const flight = db.flights.find((f) => f.id === seg.flight_id)!;
      const joined = flightJoinRow(db, flight);
      return [
        {
          segment_id: seg.id,
          cabin: seg.cabin,
          flight_id: flight.id,
          flight_no: flight.flight_no,
          depart_at: flight.depart_at,
          arrive_at: flight.arrive_at,
          duration_min: flight.duration_min,
          from_iata: joined.from_iata,
          from_city: joined.from_city,
          to_iata: joined.to_iata,
          to_city: joined.to_city,
        },
      ];
    }
    if (text.includes("from public.passengers") && text.includes("and id = ?") && text.includes("given_name")) {
      const [pnr, id] = v as [string, number];
      return db.passengers
        .filter((p) => p.booking_pnr === pnr && p.id === id)
        .map((p) => ({ id: p.id, given_name: p.given_name, family_name: p.family_name, seat_id: p.seat_id }));
    }
    if (text.includes("select total_eur from public.bookings where pnr = ?")) {
      const [pnr] = v as [string];
      const booking = db.bookings.find((b) => b.pnr === pnr);
      return booking ? [{ total_eur: booking.total_eur }] : [];
    }

    // --- rebook transaction ------------------------------------------------
    if (
      text.includes("select pnr, session_id, status, total_eur") &&
      text.includes("from public.bookings") &&
      text.includes("for update")
    ) {
      const [pnr] = v as [string];
      const booking = db.bookings.find((b) => b.pnr === pnr);
      return booking
        ? [{ pnr: booking.pnr, session_id: booking.session_id, status: booking.status, total_eur: booking.total_eur }]
        : [];
    }
    if (
      text.includes("from public.booking_segments") &&
      text.includes("where id = ?") &&
      text.includes("and booking_pnr = ?") &&
      text.includes("for update")
    ) {
      const [segmentId, pnr] = v as [number, string];
      const seg = db.booking_segments.find((s) => s.id === segmentId && s.booking_pnr === pnr);
      return seg
        ? [{ id: seg.id, flight_id: seg.flight_id, cabin: seg.cabin, segment_no: seg.segment_no }]
        : [];
    }
    if (text.includes("insert into public.ops_rebookings") && text.includes("do nothing returning id")) {
      const [pnr, passengerId, fromSegmentId, fromFlightId, toFlightId, toSegmentId, cabin] = v as [
        string, number | null, number, string, string, number, string,
      ];
      const exists = db.ops_rebookings.some(
        (r) => r.pnr === pnr && r.from_segment_id === fromSegmentId && r.to_flight_id === toFlightId,
      );
      if (exists) return [];
      const id = ++rebookSeq;
      db.ops_rebookings.push({
        id, pnr, passenger_id: passengerId, from_segment_id: fromSegmentId,
        from_flight_id: fromFlightId, to_flight_id: toFlightId, to_segment_id: toSegmentId,
        cabin, seat_id: null, fare_delta_eur: 0,
      });
      return [{ id }];
    }
    if (
      text.includes("select seats_available from public.flight_fares") &&
      text.includes("and cabin = ?") &&
      text.includes("for update")
    ) {
      const [flightId, cabin] = v as [string, string];
      const fare = db.flight_fares.find((ff) => ff.flight_id === flightId && ff.cabin === cabin);
      return fare ? [{ seats_available: fare.seats_available }] : [];
    }
    if (
      text.includes("select id, passenger_no, seat_id") &&
      text.includes("from public.passengers") &&
      text.includes("order by passenger_no")
    ) {
      const [pnr] = v as [string];
      return db.passengers
        .filter((p) => p.booking_pnr === pnr)
        .sort((a, b) => (a.passenger_no as number) - (b.passenger_no as number))
        .map((p) => ({ id: p.id, passenger_no: p.passenger_no, seat_id: p.seat_id }));
    }
    if (
      text.includes("select seat_id, price_eur from public.flight_seats") &&
      text.includes("and status = 'available'") &&
      text.includes("for update")
    ) {
      const [flightId, cabin, limit] = v as [string, string, number];
      return db.flight_seats
        .filter((s) => s.flight_id === flightId && s.cabin === cabin && s.status === "available")
        .sort((a, b) => (a.seat_id as string).localeCompare(b.seat_id as string))
        .slice(0, limit)
        .map((s) => ({ seat_id: s.seat_id, price_eur: s.price_eur }));
    }
    if (
      text.includes("update public.flight_seats") &&
      text.includes("set status = 'available'") &&
      text.includes("seat_id in")
    ) {
      const [flightId, seatIds] = [v[0] as string, v[1] as string[]];
      for (const s of db.flight_seats) {
        if (s.flight_id === flightId && seatIds.includes(s.seat_id as string) && (s.status === "held" || s.status === "taken")) {
          s.status = "available";
        }
      }
      return [];
    }
    if (text.includes("delete from public.seat_holds") && text.includes("seat_id in")) {
      const [flightId, seatIds] = [v[0] as string, v[1] as string[]];
      db.seat_holds = db.seat_holds.filter(
        (h) => !(h.flight_id === flightId && seatIds.includes(h.seat_id as string)),
      );
      return [];
    }
    if (text.includes("update public.flight_fares") && text.includes("seats_available = seats_available + ?")) {
      const [amount, flightId, cabin] = v as [number, string, string];
      const fare = db.flight_fares.find((ff) => ff.flight_id === flightId && ff.cabin === cabin);
      if (fare) fare.seats_available = (fare.seats_available as number) + amount;
      return [];
    }
    if (text.includes("update public.booking_segments") && text.includes("set flight_id = ?")) {
      const [flightId, cabin, segmentId] = v as [string, string, number];
      const seg = db.booking_segments.find((s) => s.id === segmentId);
      if (seg) {
        seg.flight_id = flightId;
        seg.cabin = cabin;
      }
      return [];
    }
    if (
      text.includes("update public.flight_seats") &&
      text.includes("set status = ?") &&
      text.includes("and seat_id = ?")
    ) {
      const [status, flightId, seatId] = v as [string, string, string];
      const seat = db.flight_seats.find((s) => s.flight_id === flightId && s.seat_id === seatId);
      if (seat) seat.status = status;
      return [];
    }
    if (text.includes("insert into public.seat_holds")) {
      db.seat_holds.push({ flight_id: v[0], seat_id: v[1], session_id: v[2], expires_at: v[3] });
      return [];
    }
    if (text.includes("update public.passengers") && text.includes("set seat_id = ?") && text.includes("where id = ?")) {
      const [seatId, id] = v as [string, number];
      const passenger = db.passengers.find((p) => p.id === id);
      if (passenger) passenger.seat_id = seatId;
      return [];
    }
    if (text.includes("update public.flight_fares") && text.includes("seats_available = seats_available - ?")) {
      const [amount, flightId, cabin] = v as [number, string, string];
      const fare = db.flight_fares.find((ff) => ff.flight_id === flightId && ff.cabin === cabin);
      if (fare) fare.seats_available = (fare.seats_available as number) - amount;
      return [];
    }

    // --- recomputeBookingTotals -------------------------------------------
    if (
      text.includes("select bs.cabin, ff.base_eur") &&
      text.includes("from public.booking_segments bs") &&
      text.includes("join public.flight_fares ff")
    ) {
      const [pnr] = v as [string];
      const out: Row[] = [];
      for (const seg of db.booking_segments.filter((s) => s.booking_pnr === pnr)) {
        const fare = db.flight_fares.find((ff) => ff.flight_id === seg.flight_id && ff.cabin === seg.cabin);
        if (fare) {
          out.push({ cabin: seg.cabin, base_eur: fare.base_eur, taxes_eur: fare.taxes_eur, surface_eur: fare.surface_eur });
        }
      }
      return out;
    }
    if (text.includes("select pax, promo_code from public.bookings where pnr = ?")) {
      const [pnr] = v as [string];
      const booking = db.bookings.find((b) => b.pnr === pnr)!;
      return [{ pax: booking.pax, promo_code: booking.promo_code ?? null }];
    }
    if (text.includes("coalesce(sum(seat_price), 0)") && text.includes("distinct on")) {
      const [pnr] = v as [string];
      let seatsEur = 0;
      for (const p of db.passengers.filter((pp) => pp.booking_pnr === pnr && pp.seat_id)) {
        const segs = db.booking_segments
          .filter((s) => s.booking_pnr === pnr)
          .sort((a, b) => (a.segment_no as number) - (b.segment_no as number));
        for (const seg of segs) {
          const seat = db.flight_seats.find((s) => s.flight_id === seg.flight_id && s.seat_id === p.seat_id);
          if (seat) {
            seatsEur += seat.price_eur as number;
            break;
          }
        }
      }
      return [{ seats_eur: seatsEur }];
    }
    if (text.includes("coalesce(sum(m.price_eur), 0)")) {
      return [{ meals_eur: 0 }];
    }
    if (text.includes("update public.bookings") && text.includes("set base_eur = ?")) {
      const [base, seats, meals, taxes, surface, discount, total, pnr] = v as number[] & string[];
      const booking = db.bookings.find((b) => b.pnr === (pnr as unknown as string))!;
      booking.base_eur = base;
      booking.seats_eur = seats;
      booking.meals_eur = meals;
      booking.taxes_eur = taxes;
      booking.surface_eur = surface;
      booking.discount_eur = discount;
      booking.total_eur = total;
      return [];
    }
    if (text.includes("update public.ops_rebookings") && text.includes("set seat_id = ?")) {
      const [seatId, fareDelta, id] = v as [string, number, number];
      const row = db.ops_rebookings.find((r) => r.id === id);
      if (row) {
        row.seat_id = seatId;
        row.fare_delta_eur = fareDelta;
      }
      return [];
    }

    throw new Error(`Unhandled query in fake sql: ${text}`);
  }

  const callable = ((arg: unknown, ...rest: unknown[]) => {
    if (Array.isArray(arg) && "raw" in arg) {
      const text = (arg as string[]).join(" ? ").replace(/\s+/g, " ").trim().toLowerCase();
      return Promise.resolve(dispatch(text, rest));
    }
    return { [paramMarker]: arg };
  }) as unknown as postgres.Sql;

  (callable as unknown as { begin: (cb: (tx: postgres.Sql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(callable);
  (callable as unknown as { json: (value: unknown) => Wrapped }).json = (value) => ({ [jsonMarker]: value });

  return callable;
}

function buildDb(): Db {
  // Anchor the scenario a few days in the future so the future-only filters in
  // listAlternatives and rebookPassenger behave as they would in production.
  const departA = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  departA.setUTCHours(13, 0, 0, 0);
  const departB = new Date(departA.getTime() + 2 * 60 * 60 * 1000);
  const arriveA = new Date(departA.getTime() + 540 * 60 * 1000);
  const arriveB = new Date(departB.getTime() + 540 * 60 * 1000);
  const onwardDepart = new Date(departA);
  onwardDepart.setUTCDate(onwardDepart.getUTCDate() + 1);
  onwardDepart.setUTCHours(9, 0, 0, 0);
  const onwardArrive = new Date(onwardDepart.getTime() + 265 * 60 * 1000);

  return {
    airports: [
      { iata: "LHR", city: "London" },
      { iata: "ORD", city: "Chicago" },
      { iata: "SFO", city: "San Francisco" },
    ],
    routes: [
      { id: 1, from_iata: "LHR", to_iata: "ORD" },
      { id: 2, from_iata: "ORD", to_iata: "SFO" },
    ],
    flights: [
      {
        id: "f1", flight_no: "FL228", route_id: 1, aircraft_type: "A350-900",
        depart_at: departA, arrive_at: arriveA, duration_min: 540, status: "scheduled",
        disrupted_at: null, disruption_reason: null,
      },
      {
        id: "f2", flight_no: "FL230", route_id: 1, aircraft_type: "A350-900",
        depart_at: departB, arrive_at: arriveB, duration_min: 540, status: "scheduled",
        disrupted_at: null, disruption_reason: null,
      },
      {
        id: "f3", flight_no: "FL999", route_id: 1, aircraft_type: "A350-900",
        depart_at: departB, arrive_at: arriveB, duration_min: 540, status: "cancelled",
        disrupted_at: null, disruption_reason: null,
      },
      {
        id: "f4", flight_no: "FL240", route_id: 2, aircraft_type: "A321XLR",
        depart_at: onwardDepart, arrive_at: onwardArrive, duration_min: 265, status: "scheduled",
        disrupted_at: null, disruption_reason: null,
      },
    ],
    flight_fares: [
      { flight_id: "f1", cabin: "L", base_eur: 700, taxes_eur: 98, surface_eur: 18, seats_total: 24, seats_available: 2 },
      { flight_id: "f2", cabin: "L", base_eur: 665, taxes_eur: 93, surface_eur: 18, seats_total: 24, seats_available: 20 },
      { flight_id: "f3", cabin: "L", base_eur: 690, taxes_eur: 96, surface_eur: 18, seats_total: 24, seats_available: 24 },
      { flight_id: "f4", cabin: "L", base_eur: 880, taxes_eur: 123, surface_eur: 18, seats_total: 24, seats_available: 20 },
    ],
    flight_seats: [
      { flight_id: "f1", seat_id: "12A", cabin: "L", zone: "Forward window", price_eur: 45, status: "taken" },
      { flight_id: "f1", seat_id: "12B", cabin: "L", zone: "Forward window", price_eur: 45, status: "taken" },
      { flight_id: "f2", seat_id: "20A", cabin: "L", zone: "Forward window", price_eur: 45, status: "available" },
      { flight_id: "f2", seat_id: "20B", cabin: "L", zone: "Forward window", price_eur: 45, status: "available" },
      { flight_id: "f2", seat_id: "20C", cabin: "L", zone: "Forward window", price_eur: 45, status: "available" },
    ],
    seat_holds: [],
    bookings: [
      {
        pnr: "DIS001", session_id: "d15c0000-0000-4000-8000-000000000001", status: "confirmed",
        contact: { name: "Aiden Abara", email: "aiden.abara@example.com", phone: "+1 312 555 1001" },
        pax: 1, base_eur: 700, seats_eur: 45, meals_eur: 0, taxes_eur: 98, surface_eur: 18,
        total_eur: 861, promo_code: null, discount_eur: 0,
      },
      {
        pnr: "DIS002", session_id: "d15c0000-0000-4000-8000-000000000002", status: "confirmed",
        contact: { name: "Bianca Bright", email: "bianca.bright@example.com", phone: "+1 312 555 1002" },
        pax: 1, base_eur: 1580, seats_eur: 45, meals_eur: 0, taxes_eur: 221, surface_eur: 36,
        total_eur: 1882, promo_code: null, discount_eur: 0,
      },
    ],
    booking_segments: [
      { id: 10, booking_pnr: "DIS001", flight_id: "f1", cabin: "L", segment_no: 1 },
      { id: 11, booking_pnr: "DIS002", flight_id: "f1", cabin: "L", segment_no: 1 },
      { id: 12, booking_pnr: "DIS002", flight_id: "f4", cabin: "L", segment_no: 2 },
    ],
    passengers: [
      {
        id: 100, booking_pnr: "DIS001", passenger_no: 1, given_name: "Aiden", family_name: "Abara",
        seat_id: "12A", loyalty_tier: null, service_tags: [], meal_id: null,
      },
      {
        id: 101, booking_pnr: "DIS002", passenger_no: 1, given_name: "Bianca", family_name: "Bright",
        seat_id: "12B", loyalty_tier: "gold", service_tags: ["tight_connection"], meal_id: null,
      },
    ],
    booking_events: [],
    ops_rebookings: [],
  };
}

describe("listFlightPassengers", () => {
  it("returns booked passengers with contact and onward-connection info", async () => {
    const db = buildDb();
    const sql = makeSql(db);
    const passengers = await listFlightPassengers(sql, "f1");

    expect(passengers).toHaveLength(2);
    const solo = passengers.find((p) => p.pnr === "DIS001")!;
    expect(solo.contact.email).toBe("aiden.abara@example.com");
    expect(solo.hasConnection).toBe(false);
    expect(solo.onwardConnection).toBeNull();

    const connecting = passengers.find((p) => p.pnr === "DIS002")!;
    expect(connecting.hasConnection).toBe(true);
    expect(connecting.onwardConnection?.flightNo).toBe("FL240");
    expect(connecting.onwardConnection?.to.iata).toBe("SFO");
  });
});

describe("cancelFlight", () => {
  it("cancels the flight, returns the fan-out, and is idempotent", async () => {
    const db = buildDb();
    const sql = makeSql(db);
    const flight = (await resolveFlight(sql, { flightNo: "FL228", flightId: "f1" }))!;

    const first = await cancelFlight(sql, flight, { reason: "weather" });
    expect(first.alreadyCancelled).toBe(false);
    expect(first.flight.status).toBe("cancelled");
    expect(first.affected.bookings).toBe(2);
    expect(first.affected.passengers).toBe(2);
    expect(first.affected.withConnections).toBe(1);
    expect(db.booking_events.filter((e) => e.actor)).toHaveLength(2);

    const flightAgain = (await resolveFlight(sql, { flightId: "f1" }))!;
    const second = await cancelFlight(sql, flightAgain, { reason: "weather" });
    expect(second.alreadyCancelled).toBe(true);
    // No duplicate disruption events on the re-run.
    expect(db.booking_events).toHaveLength(2);
  });
});

describe("listAlternatives", () => {
  it("returns same-route future flights with fare differences, excluding cancelled", async () => {
    const db = buildDb();
    const sql = makeSql(db);
    const flight = (await resolveFlight(sql, { flightId: "f1" }))!;

    const alternatives = await listAlternatives(sql, flight, { windowDays: 1 });
    const flightNos = alternatives.map((a) => a.flightNo);
    expect(flightNos).toContain("FL230");
    expect(flightNos).not.toContain("FL999"); // cancelled
    expect(flightNos).not.toContain("FL228"); // the disrupted flight itself

    const fl230 = alternatives.find((a) => a.flightNo === "FL230")!;
    const linen = fl230.fares.find((f) => f.cabin === "L")!;
    expect(linen.fareDiffEur).toBe(665 - 700);
    expect(linen.seatsAvailable).toBe(20);
    expect(fl230.seatsAvailableTotal).toBe(20);
  });
});

describe("rebookPassenger", () => {
  it("moves the segment, adjusts inventory and totals, and is idempotent", async () => {
    const db = buildDb();
    const sql = makeSql(db);

    const result = await rebookPassenger(sql, {
      pnr: "DIS001",
      passengerId: 100,
      fromSegmentId: 10,
      toFlightId: "f2",
      cabin: "L",
    });

    expect(result.alreadyRebooked).toBe(false);
    expect(result.itinerary.flight.flightNo).toBe("FL230");
    expect(result.itinerary.seatId).toBe("20A");

    // Old seat freed, new seat taken.
    expect(db.flight_seats.find((s) => s.flight_id === "f1" && s.seat_id === "12A")!.status).toBe("available");
    expect(db.flight_seats.find((s) => s.flight_id === "f2" && s.seat_id === "20A")!.status).toBe("taken");
    // Segment moved.
    expect(db.booking_segments.find((s) => s.id === 10)!.flight_id).toBe("f2");
    // Inventory counters adjusted (f1: 2 -> 3, f2: 20 -> 19).
    expect(db.flight_fares.find((ff) => ff.flight_id === "f1" && ff.cabin === "L")!.seats_available).toBe(3);
    expect(db.flight_fares.find((ff) => ff.flight_id === "f2" && ff.cabin === "L")!.seats_available).toBe(19);
    // Totals recomputed to the new (cheaper) fare: 665 + 45 seat + 93 tax + 18 surface.
    expect(db.bookings.find((b) => b.pnr === "DIS001")!.total_eur).toBe(821);
    expect(result.itinerary.fareDeltaEur).toBe(821 - 861);
    // Ledger + audit events recorded.
    expect(db.ops_rebookings).toHaveLength(1);
    expect(db.ops_rebookings[0]!.fare_delta_eur).toBe(-40);
    expect(db.booking_events.map((e) => e).length).toBe(2);

    // Re-running the same move is a no-op that returns the existing result.
    const again = await rebookPassenger(sql, {
      pnr: "DIS001",
      passengerId: 100,
      fromSegmentId: 10,
      toFlightId: "f2",
      cabin: "L",
    });
    expect(again.alreadyRebooked).toBe(true);
    expect(db.ops_rebookings).toHaveLength(1);
    expect(db.flight_fares.find((ff) => ff.flight_id === "f2" && ff.cabin === "L")!.seats_available).toBe(19);
  });
});
