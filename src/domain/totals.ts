// Recompute booking totals from the current state of passengers + segments.
// Called whenever passengers, seats, or meals change so the booking row's
// derived columns stay in sync.

import type postgres from "postgres";
import type { BookingTotals } from "./types.js";
import { computePromoDiscountEur, lookupPromo } from "./promo.js";

export async function recomputeBookingTotals(
  sql: postgres.Sql,
  pnr: string,
): Promise<BookingTotals> {
  // We expect exactly one segment in v1, but the query supports many.
  const fareRows = (await sql`
    select bs.cabin, ff.base_eur, ff.taxes_eur, ff.surface_eur
    from public.booking_segments bs
    join public.flight_fares ff
      on ff.flight_id = bs.flight_id and ff.cabin = bs.cabin
    where bs.booking_pnr = ${pnr}
  `) as unknown as Array<{
    cabin: string;
    base_eur: number;
    taxes_eur: number;
    surface_eur: number;
  }>;

  const bookingRow = (await sql`
    select pax, promo_code from public.bookings where pnr = ${pnr}
  `) as unknown as Array<{ pax: number; promo_code: string | null }>;
  if (bookingRow.length === 0) {
    throw new Error(`Booking ${pnr} not found`);
  }
  const pax = bookingRow[0]!.pax;
  const promoCode = bookingRow[0]!.promo_code;

  const baseEur =
    fareRows.reduce((sum, row) => sum + row.base_eur, 0) * pax;
  const surfaceEur =
    fareRows.reduce((sum, row) => sum + row.surface_eur, 0) * pax;
  // Use the per-flight taxes when the fare row carries them, else derive.
  // The seed sets taxes_eur to 14% of base; falling back to that keeps the
  // total sensible if the source row hasn't been updated.
  const taxesEur =
    fareRows.reduce(
      (sum, row) =>
        sum + (row.taxes_eur > 0 ? row.taxes_eur : Math.round(row.base_eur * 0.14)),
      0,
    ) * pax;

  const seatSumRows = (await sql`
    select coalesce(sum(fs.price_eur), 0)::int as seats_eur
    from public.passengers p
    left join public.booking_segments bs on bs.booking_pnr = p.booking_pnr
    left join public.flight_seats fs
      on fs.flight_id = bs.flight_id and fs.seat_id = p.seat_id
    where p.booking_pnr = ${pnr} and p.seat_id is not null
  `) as unknown as Array<{ seats_eur: number }>;
  const seatsEur = seatSumRows[0]?.seats_eur ?? 0;

  const mealSumRows = (await sql`
    select coalesce(sum(m.price_eur), 0)::int as meals_eur
    from public.passengers p
    join public.meals m on m.id = p.meal_id
    where p.booking_pnr = ${pnr}
  `) as unknown as Array<{ meals_eur: number }>;
  const mealsEur = mealSumRows[0]?.meals_eur ?? 0;

  const preDiscountTotal = baseEur + seatsEur + mealsEur + taxesEur + surfaceEur;

  // Apply a promo discount to the fare components only (never taxes). With no
  // promo the discount is 0 and the total matches the pre-discount sum, so
  // non-promo bookings behave exactly as before.
  const promo = lookupPromo(promoCode);
  const discountEur = promo
    ? computePromoDiscountEur({
        percentOff: promo.percentOff,
        baseEur,
        seatsEur,
        mealsEur,
        surfaceEur,
      })
    : 0;
  const totalEur = preDiscountTotal - discountEur;

  await sql`
    update public.bookings
    set base_eur = ${baseEur},
        seats_eur = ${seatsEur},
        meals_eur = ${mealsEur},
        taxes_eur = ${taxesEur},
        surface_eur = ${surfaceEur},
        discount_eur = ${discountEur},
        total_eur = ${totalEur}
    where pnr = ${pnr}
  `;

  return {
    baseEur,
    seatsEur,
    mealsEur,
    taxesEur,
    surfaceEur,
    discountEur,
    totalEur,
  };
}
