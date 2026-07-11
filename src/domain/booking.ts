// Booking lifecycle: create draft, update passengers / contact / meals,
// confirm, cancel. Seat hold and payment logic live in their own modules
// to keep the surface focused.

import type postgres from "postgres";
import { generatePnr } from "../lib/pnr.js";
import { recomputeBookingTotals } from "./totals.js";
import { isOutageActiveForRequest } from "./ops.js";
import { fuelSurchargeEur } from "./fare-adjustment.js";
import type { CabinCode, ContactDetails } from "./types.js";

export const HOLD_MINUTES = 10;
const DEFAULT_PASSENGER_SEEDS: Array<{ given: string; family: string }> = [
  { given: "Jane", family: "Voss" },
  { given: "Milo", family: "Hart" },
  { given: "Anya", family: "Mercer" },
  { given: "Elliot", family: "Sato" },
  { given: "Lina", family: "Dahl" },
  { given: "Tomas", family: "Reyes" },
  { given: "Iris", family: "Bauer" },
  { given: "Otis", family: "Khan" },
  { given: "Maren", family: "Quist" },
];

const DEFAULT_MEAL_ID = "seasonal";

export type CreateDraftInput = {
  flightId: string;
  cabin: CabinCode;
  pax: number;
  sessionId: string;
  contact?: ContactDetails;
  // Optional scoped-outage session id forwarded from the request (the
  // DEMO_SESSION_HEADER). When it identifies an active scoped session the
  // pricing path breaks for this booking only, leaving other callers healthy.
  demoSessionId?: string;
};

export type CreateDraftResult = {
  pnr: string;
  holdExpiresAt: string;
};

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

async function generateUniquePnr(
  tx: postgres.TransactionSql,
  attempts = 5,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const candidate = generatePnr();
    const existing = (await tx`
      select 1 from public.bookings where pnr = ${candidate} limit 1
    `) as unknown as Array<{ "?column?": number }>;
    if (existing.length === 0) {
      return candidate;
    }
  }
  throw new DomainError(
    500,
    "Could not allocate a unique booking reference. Please try again.",
    "pnr_collision",
  );
}

export async function createDraftBooking(
  sql: postgres.Sql,
  input: CreateDraftInput,
): Promise<CreateDraftResult> {
  const surchargeOn = await isOutageActiveForRequest(sql, input.demoSessionId);
  return sql.begin(async (tx) => {
    const fareRows = (await tx`
      select ff.flight_id, ff.cabin, ff.base_eur, ff.taxes_eur, ff.surface_eur,
             ff.seats_available, f.depart_at, r.from_iata, r.to_iata
      from public.flight_fares ff
      join public.flights f on f.id = ff.flight_id
      join public.routes r on r.id = f.route_id
      where ff.flight_id = ${input.flightId}
        and ff.cabin = ${input.cabin}
      for update of ff
    `) as unknown as Array<{
      flight_id: string;
      cabin: string;
      base_eur: number;
      taxes_eur: number;
      surface_eur: number;
      seats_available: number;
      depart_at: Date;
      from_iata: string;
      to_iata: string;
    }>;
    if (fareRows.length === 0) {
      throw new DomainError(
        404,
        `Cabin ${input.cabin} is not offered on this flight`,
        "fare_not_found",
      );
    }
    const fare = fareRows[0]!;
    if (fare.seats_available < input.pax) {
      throw new DomainError(
        409,
        `Only ${fare.seats_available} ${input.cabin} seats remain on this flight`,
        "insufficient_inventory",
      );
    }
    if (fare.depart_at.getTime() <= Date.now()) {
      throw new DomainError(
        409,
        "Cannot create a booking on a flight that has already departed",
        "flight_departed",
      );
    }

    const pnr = await generateUniquePnr(tx);
    const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

    const baseEur = fare.base_eur * input.pax;
    const taxesEur =
      (fare.taxes_eur > 0 ? fare.taxes_eur : Math.round(fare.base_eur * 0.14)) *
      input.pax;
    const surfaceEur = fare.surface_eur * input.pax;
    const fuelEur = surchargeOn
      ? fuelSurchargeEur({
          origin: fare.from_iata,
          destination: fare.to_iata,
          baseEur: fare.base_eur,
          pax: input.pax,
        })
      : 0;
    const totalEur = baseEur + taxesEur + surfaceEur + fuelEur;

    await tx`
      insert into public.bookings (
        pnr, session_id, status, contact, pax,
        base_eur, seats_eur, meals_eur, taxes_eur, surface_eur, total_eur,
        hold_expires_at
      ) values (
        ${pnr}, ${input.sessionId}, 'draft',
        ${tx.json(input.contact ?? {})}, ${input.pax},
        ${baseEur}, 0, 0, ${taxesEur}, ${surfaceEur}, ${totalEur},
        ${holdExpiresAt.toISOString()}
      )
    `;

    await tx`
      insert into public.booking_segments (booking_pnr, flight_id, cabin, segment_no)
      values (${pnr}, ${input.flightId}, ${input.cabin}, 1)
    `;

    const passengerRows = Array.from({ length: input.pax }, (_, i) => {
      const seed = DEFAULT_PASSENGER_SEEDS[i % DEFAULT_PASSENGER_SEEDS.length]!;
      return {
        booking_pnr: pnr,
        passenger_no: i + 1,
        given_name: seed.given,
        family_name: seed.family,
        loyalty_no: null as string | null,
        notes: null as string | null,
        seat_id: null as string | null,
        meal_id: DEFAULT_MEAL_ID,
      };
    });

    const passengerHelper = tx(
      passengerRows,
      "booking_pnr",
      "passenger_no",
      "given_name",
      "family_name",
      "loyalty_no",
      "notes",
      "seat_id",
      "meal_id",
    );
    await tx`insert into public.passengers ${passengerHelper}`;

    await tx`
      update public.flight_fares
      set seats_available = seats_available - ${input.pax}
      where flight_id = ${input.flightId} and cabin = ${input.cabin}
    `;

    return { pnr, holdExpiresAt: holdExpiresAt.toISOString() };
  });
}

export async function updateContact(
  sql: postgres.Sql,
  pnr: string,
  contact: ContactDetails,
): Promise<void> {
  await sql`
    update public.bookings
    set contact = ${sql.json(contact)}
    where pnr = ${pnr}
  `;
}

export type PassengerUpsertInput = {
  passengerNo: number;
  givenName: string;
  familyName: string;
  loyaltyNo?: string | null;
  notes?: string | null;
};

export async function upsertPassengers(
  sql: postgres.Sql,
  pnr: string,
  passengers: PassengerUpsertInput[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const booking = (await tx`
      select pax, status from public.bookings where pnr = ${pnr} for update
    `) as unknown as Array<{ pax: number; status: string }>;
    if (booking.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    if (booking[0]!.status === "cancelled") {
      throw new DomainError(
        409,
        "Booking has been cancelled",
        "booking_cancelled",
      );
    }
    if (booking[0]!.status === "confirmed") {
      throw new DomainError(
        409,
        "Booking is confirmed; passenger details are locked",
        "booking_locked",
      );
    }
    if (passengers.length !== booking[0]!.pax) {
      throw new DomainError(
        422,
        `Expected ${booking[0]!.pax} passenger entries, got ${passengers.length}`,
        "passenger_count_mismatch",
      );
    }

    for (const passenger of passengers) {
      if (!passenger.givenName.trim() || !passenger.familyName.trim()) {
        throw new DomainError(
          422,
          `Passenger ${passenger.passengerNo} is missing a name`,
          "passenger_name_required",
        );
      }
      await tx`
        update public.passengers
        set given_name = ${passenger.givenName.trim()},
            family_name = ${passenger.familyName.trim()},
            loyalty_no = ${passenger.loyaltyNo ?? null},
            notes = ${passenger.notes ?? null}
        where booking_pnr = ${pnr} and passenger_no = ${passenger.passengerNo}
      `;
    }
  });
}

export type MealAssignment = {
  passengerNo: number;
  mealId: string;
};

export async function assignMeals(
  sql: postgres.Sql,
  pnr: string,
  assignments: MealAssignment[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const cabinRows = (await tx`
      select cabin from public.booking_segments where booking_pnr = ${pnr}
    `) as unknown as Array<{ cabin: string }>;
    const bookingCabins = new Set(cabinRows.map((row) => row.cabin));

    for (const assignment of assignments) {
      const mealRows = (await tx`
        select id, cabins from public.meals where id = ${assignment.mealId}
      `) as unknown as Array<{ id: string; cabins: string[] }>;
      if (mealRows.length === 0) {
        throw new DomainError(
          404,
          `Meal "${assignment.mealId}" not found`,
          "meal_not_found",
        );
      }
      const allowedForCabin = [...bookingCabins].some((cabin) =>
        mealRows[0]!.cabins.includes(cabin),
      );
      if (!allowedForCabin) {
        throw new DomainError(
          422,
          `Meal "${assignment.mealId}" is not offered in this cabin`,
          "meal_cabin_mismatch",
        );
      }
      await tx`
        update public.passengers
        set meal_id = ${assignment.mealId}
        where booking_pnr = ${pnr} and passenger_no = ${assignment.passengerNo}
      `;
    }
  });

  await recomputeBookingTotals(sql, pnr);
}
