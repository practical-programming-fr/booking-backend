// Loads a complete BookingView (booking + segments + passengers + payments)
// in a small number of queries. Used by every endpoint that returns booking
// state, so we keep its output shape stable.

import type postgres from "postgres";
import type {
  BookingView,
  CabinCode,
  ContactDetails,
  PassengerView,
  PaymentView,
  SegmentView,
} from "./types.js";

type BookingRow = {
  pnr: string;
  session_id: string;
  user_id: string | null;
  status: BookingView["status"];
  contact: ContactDetails | null;
  currency: string;
  pax: number;
  base_eur: number;
  seats_eur: number;
  meals_eur: number;
  taxes_eur: number;
  surface_eur: number;
  total_eur: number;
  promo_code: string | null;
  discount_eur: number;
  hold_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
};

type SegmentJoinRow = {
  segment_no: number;
  flight_id: string;
  cabin: CabinCode;
  flight_no: string;
  depart_at: Date;
  arrive_at: Date;
  duration_min: number;
  aircraft_type: string;
  from_iata: string;
  from_city: string;
  from_country: string;
  from_tz: string;
  to_iata: string;
  to_city: string;
  to_country: string;
  to_tz: string;
};

type PassengerRow = {
  passenger_no: number;
  given_name: string;
  family_name: string;
  loyalty_no: string | null;
  notes: string | null;
  seat_id: string | null;
  meal_id: string | null;
};

type PaymentRow = {
  id: string;
  provider: PaymentView["provider"];
  status: PaymentView["status"];
  amount_eur: number;
  cardholder: string | null;
  card_last4: string | null;
  card_brand: string | null;
  created_at: Date;
  completed_at: Date | null;
};

export async function loadBooking(
  sql: postgres.Sql,
  pnr: string,
): Promise<BookingView | null> {
  const bookings = (await sql`
    select pnr, session_id, user_id, status, contact, currency, pax,
           base_eur, seats_eur, meals_eur, taxes_eur, surface_eur, total_eur,
           promo_code, discount_eur,
           hold_expires_at, created_at, updated_at, confirmed_at, cancelled_at
    from public.bookings
    where pnr = ${pnr}
  `) as unknown as BookingRow[];

  if (bookings.length === 0) {
    return null;
  }
  const booking = bookings[0]!;

  const segments = (await sql`
    select bs.segment_no,
           bs.flight_id,
           bs.cabin,
           f.flight_no,
           f.depart_at,
           f.arrive_at,
           f.duration_min,
           f.aircraft_type,
           from_air.iata as from_iata,
           from_air.city as from_city,
           from_air.country as from_country,
           from_air.tz as from_tz,
           to_air.iata as to_iata,
           to_air.city as to_city,
           to_air.country as to_country,
           to_air.tz as to_tz
    from public.booking_segments bs
    join public.flights f on f.id = bs.flight_id
    join public.routes r on r.id = f.route_id
    join public.airports from_air on from_air.iata = r.from_iata
    join public.airports to_air on to_air.iata = r.to_iata
    where bs.booking_pnr = ${pnr}
    order by bs.segment_no asc
  `) as unknown as SegmentJoinRow[];

  const passengers = (await sql`
    select passenger_no, given_name, family_name, loyalty_no, notes, seat_id, meal_id
    from public.passengers
    where booking_pnr = ${pnr}
    order by passenger_no asc
  `) as unknown as PassengerRow[];

  const payments = (await sql`
    select id, provider, status, amount_eur, cardholder, card_last4, card_brand,
           created_at, completed_at
    from public.payments
    where booking_pnr = ${pnr}
    order by created_at desc
  `) as unknown as PaymentRow[];

  return {
    pnr: booking.pnr,
    status: booking.status,
    contact: booking.contact ?? {},
    pax: booking.pax,
    currency: "EUR",
    promoCode: booking.promo_code ?? null,
    totals: {
      baseEur: booking.base_eur,
      seatsEur: booking.seats_eur,
      mealsEur: booking.meals_eur,
      taxesEur: booking.taxes_eur,
      surfaceEur: booking.surface_eur,
      discountEur: booking.discount_eur,
      totalEur: booking.total_eur,
    },
    holdExpiresAt: booking.hold_expires_at?.toISOString() ?? null,
    createdAt: booking.created_at.toISOString(),
    updatedAt: booking.updated_at.toISOString(),
    confirmedAt: booking.confirmed_at?.toISOString() ?? null,
    cancelledAt: booking.cancelled_at?.toISOString() ?? null,
    segments: segments.map<SegmentView>((row) => ({
      segmentNo: row.segment_no,
      flightId: row.flight_id,
      cabin: row.cabin,
      flightNo: row.flight_no,
      departAt: row.depart_at.toISOString(),
      arriveAt: row.arrive_at.toISOString(),
      durationMin: row.duration_min,
      aircraft: row.aircraft_type,
      from: {
        iata: row.from_iata,
        city: row.from_city,
        country: row.from_country,
        tz: row.from_tz,
      },
      to: {
        iata: row.to_iata,
        city: row.to_city,
        country: row.to_country,
        tz: row.to_tz,
      },
    })),
    passengers: passengers.map<PassengerView>((row) => ({
      passengerNo: row.passenger_no,
      givenName: row.given_name,
      familyName: row.family_name,
      loyaltyNo: row.loyalty_no,
      notes: row.notes,
      seatId: row.seat_id,
      mealId: row.meal_id,
    })),
    payments: payments.map<PaymentView>((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      amountEur: row.amount_eur,
      cardholder: row.cardholder,
      cardLast4: row.card_last4,
      cardBrand: row.card_brand,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    })),
  };
}
