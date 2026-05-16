// Seat hold logic. A booking has a single hold window (booking.hold_expires_at).
// When seats are assigned to passengers we create one seat_holds row per seat
// pointing at that window, and flip the underlying flight_seats row to "held".
//
// Confirming the booking converts holds → taken and deletes the holds.
// Cancelling the booking releases the seats back to available and deletes the
// holds. A background cron does the same release for holds past expires_at
// on bookings that never reached confirmation.

import type postgres from "postgres";
import { DomainError } from "./booking.js";
import { recomputeBookingTotals } from "./totals.js";

export type SeatAssignmentInput = {
  passengerNo: number;
  seatId: string | null;
};

export async function assignSeats(
  sql: postgres.Sql,
  pnr: string,
  sessionId: string,
  assignments: SeatAssignmentInput[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const bookingRows = (await tx`
      select pnr, session_id, status, hold_expires_at
      from public.bookings
      where pnr = ${pnr}
      for update
    `) as unknown as Array<{
      pnr: string;
      session_id: string;
      status: string;
      hold_expires_at: Date | null;
    }>;
    if (bookingRows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const booking = bookingRows[0]!;
    if (booking.session_id !== sessionId) {
      throw new DomainError(403, "Not your booking", "booking_forbidden");
    }
    if (booking.status === "cancelled") {
      throw new DomainError(409, "Booking has been cancelled", "booking_cancelled");
    }
    if (booking.status === "confirmed") {
      throw new DomainError(409, "Booking is confirmed; seats are locked", "booking_locked");
    }
    if (!booking.hold_expires_at || booking.hold_expires_at.getTime() < Date.now()) {
      throw new DomainError(
        410,
        "Seat-hold window has expired. Please start a new booking.",
        "hold_expired",
      );
    }

    const segmentRows = (await tx`
      select flight_id, cabin from public.booking_segments where booking_pnr = ${pnr}
    `) as unknown as Array<{ flight_id: string; cabin: string }>;
    if (segmentRows.length === 0) {
      throw new DomainError(409, "Booking has no segments", "booking_invalid");
    }
    // v1: one segment per booking.
    const segment = segmentRows[0]!;

    for (const assignment of assignments) {
      // Clearing an assignment: release any current hold + revert seat status.
      const currentRows = (await tx`
        select seat_id from public.passengers
        where booking_pnr = ${pnr} and passenger_no = ${assignment.passengerNo}
      `) as unknown as Array<{ seat_id: string | null }>;
      const currentSeat = currentRows[0]?.seat_id ?? null;

      if (currentSeat && currentSeat !== assignment.seatId) {
        await tx`
          delete from public.seat_holds
          where flight_id = ${segment.flight_id} and seat_id = ${currentSeat}
        `;
        await tx`
          update public.flight_seats
          set status = 'available'
          where flight_id = ${segment.flight_id}
            and seat_id = ${currentSeat}
            and status = 'held'
        `;
      }

      if (assignment.seatId == null) {
        await tx`
          update public.passengers
          set seat_id = null
          where booking_pnr = ${pnr} and passenger_no = ${assignment.passengerNo}
        `;
        continue;
      }

      const seatRows = (await tx`
        select seat_id, cabin, status from public.flight_seats
        where flight_id = ${segment.flight_id} and seat_id = ${assignment.seatId}
        for update
      `) as unknown as Array<{ seat_id: string; cabin: string; status: string }>;
      if (seatRows.length === 0) {
        throw new DomainError(
          404,
          `Seat ${assignment.seatId} not found on this flight`,
          "seat_not_found",
        );
      }
      const seat = seatRows[0]!;
      if (seat.cabin !== segment.cabin) {
        throw new DomainError(
          422,
          `Seat ${assignment.seatId} is in cabin ${seat.cabin}, booking is in ${segment.cabin}`,
          "seat_cabin_mismatch",
        );
      }
      if (seat.status === "blocked") {
        throw new DomainError(
          409,
          `Seat ${assignment.seatId} is not available`,
          "seat_blocked",
        );
      }

      const existingHold = (await tx`
        select session_id, booking_id from public.seat_holds
        where flight_id = ${segment.flight_id} and seat_id = ${assignment.seatId}
      `) as unknown as Array<{ session_id: string; booking_id: string | null }>;
      if (existingHold.length > 0 && existingHold[0]!.session_id !== sessionId) {
        throw new DomainError(
          409,
          `Seat ${assignment.seatId} is held by another guest`,
          "seat_held",
        );
      }
      if (seat.status === "taken") {
        throw new DomainError(
          409,
          `Seat ${assignment.seatId} has already been ticketed`,
          "seat_taken",
        );
      }

      await tx`
        insert into public.seat_holds (
          flight_id, seat_id, session_id, expires_at
        ) values (
          ${segment.flight_id}, ${assignment.seatId}, ${sessionId}, ${booking.hold_expires_at!.toISOString()}
        )
        on conflict (flight_id, seat_id) do update set
          session_id = excluded.session_id,
          expires_at = excluded.expires_at
      `;
      await tx`
        update public.flight_seats
        set status = 'held'
        where flight_id = ${segment.flight_id} and seat_id = ${assignment.seatId}
      `;
      await tx`
        update public.passengers
        set seat_id = ${assignment.seatId}
        where booking_pnr = ${pnr} and passenger_no = ${assignment.passengerNo}
      `;
    }
  });

  await recomputeBookingTotals(sql, pnr);
}

/** Convert all of this booking's seat holds to "taken" and delete the holds. */
export async function convertHoldsToTaken(
  tx: postgres.TransactionSql,
  pnr: string,
): Promise<number> {
  const segments = (await tx`
    select flight_id from public.booking_segments where booking_pnr = ${pnr}
  `) as unknown as Array<{ flight_id: string }>;
  if (segments.length === 0) {
    return 0;
  }
  const flightIds = segments.map((row) => row.flight_id);

  const passengers = (await tx`
    select seat_id from public.passengers
    where booking_pnr = ${pnr} and seat_id is not null
  `) as unknown as Array<{ seat_id: string }>;
  const seatIds = passengers.map((row) => row.seat_id);
  if (seatIds.length === 0) {
    return 0;
  }

  await tx`
    update public.flight_seats
    set status = 'taken'
    where flight_id in ${tx(flightIds)}
      and seat_id in ${tx(seatIds)}
  `;
  await tx`
    delete from public.seat_holds
    where flight_id in ${tx(flightIds)}
      and seat_id in ${tx(seatIds)}
  `;
  return seatIds.length;
}

/** Release all of this booking's holds back to available. */
export async function releaseBookingSeats(
  tx: postgres.TransactionSql,
  pnr: string,
): Promise<number> {
  const segments = (await tx`
    select flight_id from public.booking_segments where booking_pnr = ${pnr}
  `) as unknown as Array<{ flight_id: string }>;
  if (segments.length === 0) {
    return 0;
  }
  const flightIds = segments.map((row) => row.flight_id);

  const passengers = (await tx`
    select seat_id from public.passengers
    where booking_pnr = ${pnr} and seat_id is not null
  `) as unknown as Array<{ seat_id: string }>;
  const seatIds = passengers.map((row) => row.seat_id);

  if (seatIds.length === 0) {
    return 0;
  }

  await tx`
    update public.flight_seats
    set status = 'available'
    where flight_id in ${tx(flightIds)}
      and seat_id in ${tx(seatIds)}
      and status in ('held', 'taken')
  `;
  await tx`
    delete from public.seat_holds
    where flight_id in ${tx(flightIds)}
      and seat_id in ${tx(seatIds)}
  `;
  await tx`
    update public.passengers set seat_id = null
    where booking_pnr = ${pnr}
  `;
  return seatIds.length;
}
