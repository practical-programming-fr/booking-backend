// Promo / discount capability.
//
// Keep it simple and config-driven: a small set of known codes each map to a
// percentage off. There is no admin CRUD; codes live in the PROMO_CODES map
// below. A promo discounts the fare components of a booking (base + seats +
// meals + surface), never the taxes, and the amount is stored on the booking
// row as `discount_eur` by recomputeBookingTotals.

import type postgres from "postgres";
import { DomainError } from "./booking.js";
import { recomputeBookingTotals } from "./totals.js";

// Known promo codes and their percentage off. Codes are matched
// case-insensitively; the canonical form is uppercase.
export const PROMO_CODES: Record<string, number> = {
  FLASH20: 20,
  WELCOME10: 10,
  SUMMER15: 15,
};

export type Promo = {
  code: string;
  percentOff: number;
};

export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// Resolve a raw user-supplied code to a known promo, or null when it is empty
// or not recognized.
export function lookupPromo(raw: string | null | undefined): Promo | null {
  if (!raw) {
    return null;
  }
  const code = normalizePromoCode(raw);
  if (!code) {
    return null;
  }
  const percentOff = PROMO_CODES[code];
  if (percentOff === undefined) {
    return null;
  }
  return { code, percentOff };
}

export type DiscountableComponents = {
  percentOff: number;
  baseEur: number;
  seatsEur: number;
  mealsEur: number;
  surfaceEur: number;
};

// Compute the whole-EUR discount for a promo. The discount applies to the fare
// components (base + seats + meals + surface) and never to taxes. It is clamped
// so it cannot exceed those components, which keeps the post-discount total at
// or above the tax floor (and never below zero).
export function computePromoDiscountEur(input: DiscountableComponents): number {
  const discountable =
    input.baseEur + input.seatsEur + input.mealsEur + input.surfaceEur;
  if (discountable <= 0 || input.percentOff <= 0) {
    return 0;
  }
  const raw = Math.round((input.percentOff / 100) * discountable);
  if (raw < 0) {
    return 0;
  }
  if (raw > discountable) {
    return discountable;
  }
  return raw;
}

// Set (or clear) the promo code on a booking, then recompute totals so the
// discount and total columns stay in sync. Passing an empty/blank code clears
// any applied promo. Throws a DomainError for unknown codes or locked bookings.
export async function setBookingPromo(
  sql: postgres.Sql,
  pnr: string,
  rawCode: string | null | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = (await tx`
      select status from public.bookings where pnr = ${pnr} for update
    `) as unknown as Array<{ status: string }>;
    if (rows.length === 0) {
      throw new DomainError(404, "Booking not found", "booking_not_found");
    }
    const status = rows[0]!.status;
    if (status === "cancelled") {
      throw new DomainError(409, "Booking has been cancelled", "booking_cancelled");
    }
    if (status === "confirmed") {
      throw new DomainError(
        409,
        "Booking is confirmed; the total is locked",
        "booking_locked",
      );
    }

    let normalized: string | null = null;
    if (rawCode && rawCode.trim()) {
      const promo = lookupPromo(rawCode);
      if (!promo) {
        throw new DomainError(
          422,
          `Promo code "${rawCode.trim()}" is not valid`,
          "promo_invalid",
        );
      }
      normalized = promo.code;
    }

    await tx`
      update public.bookings
      set promo_code = ${normalized}
      where pnr = ${pnr}
    `;
  });

  await recomputeBookingTotals(sql, pnr);
}
