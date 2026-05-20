// Mock payment provider. Creates a "payment intent" row in `pending` state
// and returns a fake client secret. Confirmation flips the row to `succeeded`
// and stores a redacted card summary.
//
// Real implementations would integrate Stripe / Adyen here. The interface is
// kept minimal so swapping is straightforward: only `createIntent` and
// `succeed` need different bodies.

import type postgres from "postgres";
import { DomainError } from "./booking.js";
import { convertHoldsToTaken } from "./seats.js";

export type CreateIntentInput = {
  pnr: string;
  sessionId: string;
};

export type CreateIntentResult = {
  paymentId: string;
  clientSecret: string;
  amountEur: number;
};

export async function createPaymentIntent(
  sql: postgres.Sql,
  input: CreateIntentInput,
): Promise<CreateIntentResult> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      select pnr, session_id, status, total_eur, hold_expires_at
      from public.bookings
      where pnr = ${input.pnr}
      for update
    `) as unknown as Array<{
      pnr: string;
      session_id: string;
      status: string;
      total_eur: number;
      hold_expires_at: Date | null;
    }>;
    if (rows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const booking = rows[0]!;
    if (booking.session_id !== input.sessionId) {
      throw new DomainError(403, "Not your booking", "booking_forbidden");
    }
    if (booking.status === "cancelled") {
      throw new DomainError(409, "Booking has been cancelled", "booking_cancelled");
    }
    if (booking.status === "confirmed") {
      throw new DomainError(409, "Booking already confirmed", "booking_locked");
    }
    if (!booking.hold_expires_at || booking.hold_expires_at.getTime() < Date.now()) {
      throw new DomainError(410, "Seat-hold window has expired", "hold_expired");
    }

    const passengerRows = (await tx`
      select count(*)::int as n_with_seats
      from public.passengers
      where booking_pnr = ${input.pnr} and seat_id is not null
    `) as unknown as Array<{ n_with_seats: number }>;
    const expected = (await tx`
      select pax from public.bookings where pnr = ${input.pnr}
    `) as unknown as Array<{ pax: number }>;
    if ((passengerRows[0]?.n_with_seats ?? 0) < (expected[0]?.pax ?? 1)) {
      throw new DomainError(
        422,
        "Every passenger needs a seat before payment",
        "seats_incomplete",
      );
    }

    await tx`
      update public.payments
      set status = 'failed'
      where booking_pnr = ${input.pnr} and status = 'pending'
    `;

    const inserted = (await tx`
      insert into public.payments (
        booking_pnr, provider, status, amount_eur
      ) values (
        ${input.pnr}, 'mock', 'pending', ${booking.total_eur}
      )
      returning id
    `) as unknown as Array<{ id: string }>;
    const paymentId = inserted[0]!.id;

    await tx`
      update public.bookings
      set status = 'awaiting_payment'
      where pnr = ${input.pnr}
    `;

    return {
      paymentId,
      clientSecret: `mock_cs_${paymentId.replace(/-/g, "")}`,
      amountEur: booking.total_eur,
    };
  });
}

export type ConfirmPaymentInput = {
  pnr: string;
  sessionId: string;
  paymentId: string;
  card: {
    cardholder: string;
    last4: string;
    brand?: string;
  };
};

export async function confirmPayment(
  sql: postgres.Sql,
  input: ConfirmPaymentInput,
): Promise<void> {
  await sql.begin(async (tx) => {
    const bookingRows = (await tx`
      select pnr, session_id, status, hold_expires_at, total_eur
      from public.bookings
      where pnr = ${input.pnr}
      for update
    `) as unknown as Array<{
      pnr: string;
      session_id: string;
      status: string;
      hold_expires_at: Date | null;
      total_eur: number;
    }>;
    if (bookingRows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const booking = bookingRows[0]!;
    if (booking.session_id !== input.sessionId) {
      throw new DomainError(403, "Not your booking", "booking_forbidden");
    }
    if (booking.status === "confirmed") {
      return;
    }
    if (booking.status === "cancelled") {
      throw new DomainError(409, "Booking has been cancelled", "booking_cancelled");
    }
    if (!booking.hold_expires_at || booking.hold_expires_at.getTime() < Date.now()) {
      throw new DomainError(410, "Seat-hold window has expired", "hold_expired");
    }

    const paymentRows = (await tx`
      select id, status, amount_eur from public.payments
      where id = ${input.paymentId} and booking_pnr = ${input.pnr}
      for update
    `) as unknown as Array<{ id: string; status: string; amount_eur: number }>;
    if (paymentRows.length === 0) {
      throw new DomainError(404, "Payment not found", "payment_not_found");
    }
    const payment = paymentRows[0]!;
    if (payment.status !== "pending") {
      throw new DomainError(
        409,
        `Payment is in status ${payment.status}; expected pending`,
        "payment_state",
      );
    }
    if (payment.amount_eur !== booking.total_eur) {
      throw new DomainError(
        409,
        "Booking total changed since payment was started",
        "payment_amount_mismatch",
      );
    }

    await tx`
      update public.payments
      set status = 'succeeded',
          cardholder = ${input.card.cardholder},
          card_last4 = ${input.card.last4},
          card_brand = ${input.card.brand ?? null},
          completed_at = now()
      where id = ${input.paymentId}
    `;

    await convertHoldsToTaken(tx, input.pnr);

    await tx`
      update public.bookings
      set status = 'confirmed',
          confirmed_at = now(),
          hold_expires_at = null
      where pnr = ${input.pnr}
    `;
  });
}

export async function cancelBooking(
  sql: postgres.Sql,
  input: { pnr: string; sessionId: string },
): Promise<void> {
  await sql.begin(async (tx) => {
    const bookingRows = (await tx`
      select pnr, session_id, status from public.bookings
      where pnr = ${input.pnr}
      for update
    `) as unknown as Array<{ pnr: string; session_id: string; status: string }>;
    if (bookingRows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const booking = bookingRows[0]!;
    if (booking.session_id !== input.sessionId) {
      throw new DomainError(403, "Not your booking", "booking_forbidden");
    }
    if (booking.status === "cancelled") {
      return;
    }

    const { releaseBookingSeats } = await import("./seats.js");
    await releaseBookingSeats(tx, input.pnr);

    // Restore inventory counters for each segment cabin.
    const segments = (await tx`
      select flight_id, cabin from public.booking_segments where booking_pnr = ${input.pnr}
    `) as unknown as Array<{ flight_id: string; cabin: string }>;
    const paxRow = (await tx`
      select pax from public.bookings where pnr = ${input.pnr}
    `) as unknown as Array<{ pax: number }>;
    const pax = paxRow[0]?.pax ?? 0;
    for (const segment of segments) {
      await tx`
        update public.flight_fares
        set seats_available = seats_available + ${pax}
        where flight_id = ${segment.flight_id} and cabin = ${segment.cabin}
      `;
    }

    await tx`
      update public.payments
      set status = case when status = 'succeeded' then 'refunded' else 'failed' end
      where booking_pnr = ${input.pnr}
        and status in ('pending', 'succeeded')
    `;

    await tx`
      update public.bookings
      set status = 'cancelled',
          cancelled_at = now(),
          hold_expires_at = null
      where pnr = ${input.pnr}
    `;
  });
}
