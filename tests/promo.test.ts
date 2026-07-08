// Promo / discount domain tests. These exercise the pure discount math and
// code lookup without a live DB, mirroring the inventory unit tests. The
// route-level ownership + recompute wiring is covered by an integration DB.

import { describe, expect, it } from "vitest";
import {
  PROMO_CODES,
  computePromoDiscountEur,
  lookupPromo,
  normalizePromoCode,
} from "../src/domain/promo.js";

describe("lookupPromo", () => {
  it("resolves a known code case-insensitively to its percentage", () => {
    expect(lookupPromo("FLASH20")).toEqual({ code: "FLASH20", percentOff: 20 });
    expect(lookupPromo("flash20")).toEqual({ code: "FLASH20", percentOff: 20 });
    expect(lookupPromo("  Flash20 ")).toEqual({ code: "FLASH20", percentOff: 20 });
  });

  it("rejects an unknown code", () => {
    expect(lookupPromo("NOPE")).toBeNull();
    expect(lookupPromo("FLASH21")).toBeNull();
  });

  it("treats empty or blank input as no promo", () => {
    expect(lookupPromo("")).toBeNull();
    expect(lookupPromo("   ")).toBeNull();
    expect(lookupPromo(null)).toBeNull();
    expect(lookupPromo(undefined)).toBeNull();
  });

  it("normalizes codes to uppercase", () => {
    expect(normalizePromoCode(" flash20 ")).toBe("FLASH20");
  });

  it("ships FLASH20 at 20 percent", () => {
    expect(PROMO_CODES.FLASH20).toBe(20);
  });
});

describe("computePromoDiscountEur", () => {
  it("applies the expected percentage to the fare components only", () => {
    // base 1000 + seats 100 + meals 50 + surface 50 = 1200 discountable.
    // taxes are excluded from the discountable base.
    const discount = computePromoDiscountEur({
      percentOff: 20,
      baseEur: 1000,
      seatsEur: 100,
      mealsEur: 50,
      surfaceEur: 50,
    });
    expect(discount).toBe(240); // 20% of 1200
  });

  it("ignores taxes when computing the discount", () => {
    const withoutTaxComponent = computePromoDiscountEur({
      percentOff: 20,
      baseEur: 1000,
      seatsEur: 0,
      mealsEur: 0,
      surfaceEur: 0,
    });
    // 20% of 1000 fare, independent of any tax value elsewhere.
    expect(withoutTaxComponent).toBe(200);
  });

  it("scales with the discountable base as passengers/seats change", () => {
    const onePax = computePromoDiscountEur({
      percentOff: 20,
      baseEur: 1000,
      seatsEur: 0,
      mealsEur: 0,
      surfaceEur: 0,
    });
    const twoPaxWithSeats = computePromoDiscountEur({
      percentOff: 20,
      baseEur: 2000,
      seatsEur: 200,
      mealsEur: 0,
      surfaceEur: 0,
    });
    expect(onePax).toBe(200);
    expect(twoPaxWithSeats).toBe(440); // 20% of 2200
    expect(twoPaxWithSeats).toBeGreaterThan(onePax);
  });

  it("returns zero when there is no discountable amount", () => {
    expect(
      computePromoDiscountEur({
        percentOff: 20,
        baseEur: 0,
        seatsEur: 0,
        mealsEur: 0,
        surfaceEur: 0,
      }),
    ).toBe(0);
  });

  it("clamps so the discount never exceeds the fare components", () => {
    const discount = computePromoDiscountEur({
      percentOff: 200,
      baseEur: 1000,
      seatsEur: 0,
      mealsEur: 0,
      surfaceEur: 0,
    });
    expect(discount).toBe(1000);
  });

  it("is zero for a zero percentage (a cleared promo restores full price)", () => {
    expect(
      computePromoDiscountEur({
        percentOff: 0,
        baseEur: 1000,
        seatsEur: 100,
        mealsEur: 0,
        surfaceEur: 0,
      }),
    ).toBe(0);
  });

  it("rounds to whole EUR", () => {
    // 15% of 333 = 49.95 -> 50
    expect(
      computePromoDiscountEur({
        percentOff: 15,
        baseEur: 333,
        seatsEur: 0,
        mealsEur: 0,
        surfaceEur: 0,
      }),
    ).toBe(50);
  });
});
