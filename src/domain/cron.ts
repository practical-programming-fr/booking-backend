// Sweep expired seat holds. Runs once a minute via Vercel Cron (see
// vercel.json). Each draft / awaiting_payment booking whose
// hold_expires_at is in the past gets its seats released and the booking
// itself flipped to "cancelled" so it can't be revived. Confirmed
// bookings are never touched here; their holds were already converted
// at confirmation time.

import type postgres from "postgres";
import { releaseBookingSeats } from "./seats.js";

export type SweepResult = {
  releasedBookings: number;
  releasedSeats: number;
  releasedOrphanHolds: number;
};

export async function sweepExpiredHolds(sql: postgres.Sql): Promise<SweepResult> {
  let releasedBookings = 0;
  let releasedSeats = 0;
  let releasedOrphanHolds = 0;

  await sql.begin(async (tx) => {
    const expired = (await tx`
      select pnr, pax
      from public.bookings
      where hold_expires_at is not null
        and hold_expires_at < now()
        and status in ('draft', 'awaiting_payment')
      for update
    `) as unknown as Array<{ pnr: string; pax: number }>;

    for (const booking of expired) {
      const segments = (await tx`
        select flight_id, cabin from public.booking_segments where booking_pnr = ${booking.pnr}
      `) as unknown as Array<{ flight_id: string; cabin: string }>;
      const seats = await releaseBookingSeats(tx, booking.pnr);
      releasedSeats += seats;
      for (const segment of segments) {
        await tx`
          update public.flight_fares
          set seats_available = seats_available + ${booking.pax}
          where flight_id = ${segment.flight_id} and cabin = ${segment.cabin}
        `;
      }
      await tx`
        update public.payments
        set status = 'failed'
        where booking_pnr = ${booking.pnr} and status = 'pending'
      `;
      await tx`
        update public.bookings
        set status = 'cancelled',
            cancelled_at = now(),
            hold_expires_at = null
        where pnr = ${booking.pnr}
      `;
      releasedBookings++;
    }

    // Defensive sweep: any holds without a booking (shouldn't happen but
    // catches leaks) or past their expires_at outside of the booking flow.
    const orphans = (await tx`
      delete from public.seat_holds
      where expires_at < now()
      returning flight_id, seat_id
    `) as unknown as Array<{ flight_id: string; seat_id: string }>;
    if (orphans.length > 0) {
      releasedOrphanHolds = orphans.length;
      const flightIds = [...new Set(orphans.map((row) => row.flight_id))];
      const seatIds = [...new Set(orphans.map((row) => row.seat_id))];
      await tx`
        update public.flight_seats
        set status = 'available'
        where flight_id in ${tx(flightIds)}
          and seat_id in ${tx(seatIds)}
          and status = 'held'
      `;
    }
  });

  return { releasedBookings, releasedSeats, releasedOrphanHolds };
}
