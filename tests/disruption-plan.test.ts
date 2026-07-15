// Pure tests for the seeded FL228 disruption scenario plan. These lock in the
// demo-critical shape (flight FL228, ~40 booked passengers, a good fraction
// with onward connections, and same-day alternatives with availability) without
// touching a database.

import { describe, expect, it } from "vitest";
import {
  PRIMARY_FLIGHT_NO,
  buildDisruptionPlan,
} from "../src/domain/disruption-seed.js";

const BASE = new Date("2026-06-01T00:00:00Z");
// A seed time early in the day so FL228 lands on its deterministic 13:00 slot.
const EARLY_NOW = new Date("2026-06-01T03:00:00Z");

describe("buildDisruptionPlan", () => {
  it("puts FL228 later on the base day when seeded early", () => {
    const plan = buildDisruptionPlan(BASE, EARLY_NOW);
    expect(plan.primaryFlightNo).toBe(PRIMARY_FLIGHT_NO);
    expect(plan.primaryDepartAt.toISOString()).toBe("2026-06-01T13:00:00.000Z");
    expect(plan.primaryDepartAt.getTime()).toBeGreaterThan(EARLY_NOW.getTime());
  });

  it("keeps FL228 in the future even when seeded later in the day", () => {
    const lateNow = new Date("2026-06-01T18:20:00Z");
    const plan = buildDisruptionPlan(BASE, lateNow);
    expect(plan.primaryDepartAt.getTime()).toBeGreaterThan(lateNow.getTime());
  });

  it("books roughly 40 passengers across all three cabins", () => {
    const plan = buildDisruptionPlan(BASE, EARLY_NOW);
    expect(plan.bookings).toHaveLength(40);
    const byCabin = plan.bookings.reduce<Record<string, number>>((acc, booking) => {
      acc[booking.cabin] = (acc[booking.cabin] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCabin.A).toBeGreaterThan(0);
    expect(byCabin.P).toBeGreaterThan(0);
    expect(byCabin.L).toBeGreaterThan(0);
    expect(byCabin.A! + byCabin.P! + byCabin.L!).toBe(40);
  });

  it("gives a meaningful fraction of passengers an onward connection", () => {
    const plan = buildDisruptionPlan(BASE, EARLY_NOW);
    const withConnection = plan.bookings.filter((booking) => booking.hasConnection);
    const fraction = withConnection.length / plan.bookings.length;
    expect(fraction).toBeGreaterThan(0.25);
    expect(fraction).toBeLessThan(0.6);
    // Every connecting booking points at a real onward flight in the plan.
    const onwardNos = new Set(
      plan.flights.filter((f) => f.role === "onward").map((f) => f.flightNo),
    );
    for (const booking of withConnection) {
      expect(booking.onwardFlightNo).not.toBeNull();
      expect(onwardNos.has(booking.onwardFlightNo!)).toBe(true);
      expect(booking.onwardCabin).not.toBeNull();
    }
  });

  it("provides at least three same-day LHR to ORD alternatives departing after FL228", () => {
    const plan = buildDisruptionPlan(BASE, EARLY_NOW);
    const alternatives = plan.flights.filter((f) => f.role === "alternative");
    expect(alternatives.length).toBeGreaterThanOrEqual(3);
    const primaryDay = plan.primaryDepartAt.toISOString().slice(0, 10);
    for (const alt of alternatives) {
      expect(alt.routeKey).toBe("LHR-ORD");
      expect(alt.departAt.toISOString().slice(0, 10)).toBe(primaryDay);
      expect(alt.departAt.getTime()).toBeGreaterThan(plan.primaryDepartAt.getTime());
      // Alternatives keep real availability (never fully booked).
      expect(alt.occupancy).toBeLessThan(0.6);
    }
  });

  it("is deterministic for a fixed base date and seed time", () => {
    const a = buildDisruptionPlan(BASE, EARLY_NOW);
    const b = buildDisruptionPlan(BASE, EARLY_NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("uses unique PNRs and valid session UUIDs", () => {
    const plan = buildDisruptionPlan(BASE, EARLY_NOW);
    const pnrs = new Set(plan.bookings.map((booking) => booking.pnr));
    expect(pnrs.size).toBe(plan.bookings.length);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const booking of plan.bookings) {
      expect(booking.pnr).toHaveLength(6);
      expect(booking.sessionId).toMatch(uuidRe);
    }
  });
});
