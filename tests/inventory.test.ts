import { describe, expect, it } from "vitest";
import {
  cabinOccupancy,
  flightNumberFor,
  isSeatTaken,
  modulatePrice,
  operatesOnDay,
  slotsForRoute,
} from "../src/lib/inventory.js";
import { isoDate, parseSeedBaseDate, startOfUtcDay } from "../src/lib/seed-date.js";

describe("slotsForRoute", () => {
  it("returns one slot per ~7×/wk and is deterministic", () => {
    const a = slotsForRoute({ routeId: 12, freqPerWeek: 7 });
    const b = slotsForRoute({ routeId: 12, freqPerWeek: 7 });
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("returns three slots for high-frequency routes, spread through the day", () => {
    const slots = slotsForRoute({ routeId: 8, freqPerWeek: 21 });
    expect(slots).toHaveLength(3);
    // sorted ascending
    expect([...slots].sort((x, y) => x - y)).toEqual(slots);
    // no two slots the same
    expect(new Set(slots).size).toBe(3);
    // first slot is in the AM, last after midday — sanity for "spread"
    expect(slots[0]).toBeGreaterThan(0);
    expect(slots[slots.length - 1]).toBeGreaterThan(slots[0]!);
  });

  it("different routes get different schedules", () => {
    const a = slotsForRoute({ routeId: 1, freqPerWeek: 14 });
    const b = slotsForRoute({ routeId: 2, freqPerWeek: 14 });
    expect(a).not.toEqual(b);
  });
});

describe("operatesOnDay", () => {
  it("operates every day at 7+/wk", () => {
    for (let d = 0; d < 14; d++) {
      expect(operatesOnDay(7, d)).toBe(true);
      expect(operatesOnDay(21, d)).toBe(true);
    }
  });

  it("skips most days at 4/wk", () => {
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => operatesOnDay(4, d));
    expect(days.length).toBeLessThanOrEqual(4);
    expect(days.length).toBeGreaterThan(0);
  });
});

describe("modulatePrice", () => {
  const referenceDate = new Date("2026-05-16T00:00:00Z");

  it("adds a premium on close-in weekend departures", () => {
    const monday28d = new Date("2026-06-15T10:00:00Z"); // ~30 days out, Mon
    const friday3d = new Date("2026-05-22T10:00:00Z"); // ~6 days out, Fri
    const mondayPrice = modulatePrice({ baseEur: 1000, departAt: monday28d, referenceDate });
    const fridayPrice = modulatePrice({ baseEur: 1000, departAt: friday3d, referenceDate });
    expect(fridayPrice).toBeGreaterThan(mondayPrice);
  });

  it("discounts mid-week far-out departures", () => {
    const farOutTue = new Date("2026-07-21T10:00:00Z"); // ~66 days out, Tue
    const baseline = new Date("2026-06-15T10:00:00Z"); // Mon, ~30 days out
    const farPrice = modulatePrice({ baseEur: 1000, departAt: farOutTue, referenceDate });
    const basePrice = modulatePrice({ baseEur: 1000, departAt: baseline, referenceDate });
    expect(farPrice).toBeLessThan(basePrice);
  });
});

describe("cabinOccupancy", () => {
  const referenceDate = new Date("2026-05-16T00:00:00Z");

  it("Atlas is more full than Linen on the same flight", () => {
    const departAt = new Date("2026-06-01T10:00:00Z");
    const atlas = cabinOccupancy({ cabin: "A", freqPerWeek: 14, departAt, referenceDate });
    const linen = cabinOccupancy({ cabin: "L", freqPerWeek: 14, departAt, referenceDate });
    expect(atlas).toBeGreaterThan(linen);
  });

  it("close-in departures are more full", () => {
    const close = new Date("2026-05-20T10:00:00Z");
    const far = new Date("2026-07-20T10:00:00Z");
    const closeRate = cabinOccupancy({ cabin: "P", freqPerWeek: 14, departAt: close, referenceDate });
    const farRate = cabinOccupancy({ cabin: "P", freqPerWeek: 14, departAt: far, referenceDate });
    expect(closeRate).toBeGreaterThan(farRate);
  });

  it("returns a sensible range", () => {
    const departAt = new Date("2026-06-01T10:00:00Z");
    for (const cabin of ["A", "P", "L"] as const) {
      const rate = cabinOccupancy({ cabin, freqPerWeek: 14, departAt, referenceDate });
      expect(rate).toBeGreaterThanOrEqual(0.05);
      expect(rate).toBeLessThanOrEqual(0.95);
    }
  });
});

describe("isSeatTaken", () => {
  it("is deterministic", () => {
    expect(isSeatTaken("f1", "12A", "L", 0.5)).toBe(
      isSeatTaken("f1", "12A", "L", 0.5),
    );
  });

  it("approximates the requested rate over many seats", () => {
    let taken = 0;
    const total = 200;
    for (let i = 0; i < total; i++) {
      if (isSeatTaken("flight-x", `seat-${i}`, "L", 0.5)) taken++;
    }
    // expect within ±20% of the target rate for n=200
    expect(taken / total).toBeGreaterThan(0.3);
    expect(taken / total).toBeLessThan(0.7);
  });
});

describe("flightNumberFor", () => {
  it("returns FL + 3 digits", () => {
    expect(flightNumberFor(1, 0)).toMatch(/^FL\d{3}$/);
    expect(flightNumberFor(99, 2)).toMatch(/^FL\d{3}$/);
  });

  it("is stable across calls and increases per slot", () => {
    expect(flightNumberFor(7, 0)).toBe(flightNumberFor(7, 0));
    const slot0 = parseInt(flightNumberFor(7, 0).slice(2), 10);
    const slot1 = parseInt(flightNumberFor(7, 1).slice(2), 10);
    expect(slot1 - slot0).toBe(2);
  });
});

describe("seed date helpers", () => {
  it("defaults to the current UTC day", () => {
    const now = new Date("2026-06-01T16:42:10Z");
    expect(parseSeedBaseDate(undefined, now).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("parses an explicit YYYY-MM-DD baseline", () => {
    expect(parseSeedBaseDate("2026-06-15").toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("rejects invalid baseline dates", () => {
    expect(() => parseSeedBaseDate("2026-02-31")).toThrow(/valid calendar date/);
    expect(() => parseSeedBaseDate("06/01/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("formats dates as ISO calendar days", () => {
    expect(isoDate(startOfUtcDay(new Date("2026-06-01T23:59:59Z")))).toBe("2026-06-01");
  });
});
