// Inventory generation helpers. Used by the seed pipeline to make the demo
// catalog feel like a real airline timetable rather than a uniform grid.
//
// Three concerns:
//
//   - slotsForRoute()   — pick realistic departure times per route, varied
//                          across the day, deterministic per route id so
//                          the same route always shows the same schedule.
//   - modulatePrice()   — apply day-of-week, weekend, and advance-purchase
//                          modulations on top of the per-flight jitter.
//   - cabinOccupancy()  — return a deterministic taken-or-not status per
//                          seat so cabins look partially full, with the
//                          rates rising as departure approaches and on
//                          popular routes.
//
// All randomness is seeded so the seed is fully reproducible.

export type SlotInput = {
  routeId: number;
  freqPerWeek: number;
};

// A spread of times an airline might dispatch flights — early commute,
// mid-morning business, around noon, mid-afternoon, evening, late evening.
// Times in minutes-from-midnight (UTC, treated as the departure local time).
const POSSIBLE_SLOTS = [
  6 * 60 + 35,   // 06:35
  8 * 60 + 15,   // 08:15
  9 * 60 + 50,   // 09:50
  11 * 60 + 25,  // 11:25
  12 * 60 + 55,  // 12:55
  14 * 60 + 30,  // 14:30
  15 * 60 + 50,  // 15:50
  17 * 60 + 20,  // 17:20
  18 * 60 + 45,  // 18:45
  20 * 60 + 10,  // 20:10
  21 * 60 + 35,  // 21:35
];

/**
 * Pick `flightsPerDay` distinct departure times for a route, seeded by
 * route id so the schedule is consistent across regenerations. Real
 * airlines run the same route at the same times every day — we mimic
 * that.
 */
export function slotsForRoute({ routeId, freqPerWeek }: SlotInput): number[] {
  const flightsPerDay = Math.min(
    POSSIBLE_SLOTS.length,
    Math.max(1, Math.round(freqPerWeek / 7)),
  );
  const seed = routeId * 31 + 7;
  const used = new Set<number>();
  const picks: number[] = [];

  for (let i = 0; i < flightsPerDay; i++) {
    let idx = (seed + i * 7) % POSSIBLE_SLOTS.length;
    let attempts = 0;
    while (used.has(idx) && attempts < POSSIBLE_SLOTS.length) {
      idx = (idx + 1) % POSSIBLE_SLOTS.length;
      attempts++;
    }
    used.add(idx);
    picks.push(POSSIBLE_SLOTS[idx]!);
  }

  picks.sort((a, b) => a - b);
  return picks;
}

/**
 * For routes that don't operate daily (< 7×/wk), decide whether a given
 * day in the seed horizon should have flights. Spreads operations across
 * the week rather than clustering at the start.
 */
export function operatesOnDay(freqPerWeek: number, dayIndex: number): boolean {
  if (freqPerWeek >= 7) return true;
  const interval = Math.max(1, Math.round(7 / freqPerWeek));
  return dayIndex % interval === 0;
}

type PriceModulationInput = {
  baseEur: number;
  departAt: Date;
  /** "today" in the seed run — used for advance-purchase calculation. */
  referenceDate: Date;
};

/**
 * Layer day-of-week, weekend, and advance-purchase price modulation on
 * top of the per-flight base. Mirrors how real airline revenue management
 * shapes fares — close-in tickets cost more, mid-week tickets cost less,
 * weekend departures carry a premium.
 */
export function modulatePrice({
  baseEur,
  departAt,
  referenceDate,
}: PriceModulationInput): number {
  const dow = departAt.getUTCDay();
  let multiplier = 1;

  if (dow === 5 || dow === 6 || dow === 0) {
    multiplier *= 1.18;
  }
  if (dow === 2 || dow === 3) {
    multiplier *= 0.92;
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysOut = Math.max(
    0,
    Math.floor((departAt.getTime() - referenceDate.getTime()) / msPerDay),
  );
  if (daysOut <= 6) {
    multiplier *= 1.32;
  } else if (daysOut <= 20) {
    multiplier *= 1.12;
  } else if (daysOut >= 50) {
    multiplier *= 0.88;
  }

  return Math.round(baseEur * multiplier);
}

type OccupancyInput = {
  cabin: "A" | "P" | "L";
  freqPerWeek: number;
  departAt: Date;
  referenceDate: Date;
};

/**
 * Target occupancy rate for a (cabin, flight). Atlas Suite is small and
 * popular and fills first; Linen tracks demand more loosely. Popular
 * routes (≥ 21/wk) carry a permanent surcharge. Close-in departures show
 * higher load factors.
 *
 * Returns a value in [0, 0.95]. The caller then marks individual seats as
 * `taken` based on a per-seat hash against this rate.
 */
export function cabinOccupancy({
  cabin,
  freqPerWeek,
  departAt,
  referenceDate,
}: OccupancyInput): number {
  const baseRate = cabin === "A" ? 0.55 : cabin === "P" ? 0.35 : 0.2;
  let rate = baseRate;

  if (freqPerWeek >= 21) rate += 0.15;
  else if (freqPerWeek <= 5) rate -= 0.08;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysOut = Math.max(
    0,
    Math.floor((departAt.getTime() - referenceDate.getTime()) / msPerDay),
  );
  if (daysOut <= 7) rate += 0.22;
  else if (daysOut <= 14) rate += 0.12;
  else if (daysOut >= 45) rate -= 0.05;

  return Math.min(0.95, Math.max(0.05, rate));
}

/**
 * Deterministic per-seat decision. The hash mixes flight id, seat id, and
 * cabin so the same flight/seat pair always lands on the same status. We
 * compare against `Math.floor(rate * 1000)` for stable rounding.
 */
export function isSeatTaken(
  flightId: string,
  seatId: string,
  cabin: string,
  rate: number,
): boolean {
  const seed = `${flightId}:${seatId}:${cabin}`;
  let hash = 7;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) & 0xffffffff;
  }
  const bucket = Math.abs(hash) % 1000;
  return bucket < Math.floor(rate * 1000);
}

/**
 * Deterministic flight-number generator. Real airlines tend to keep the
 * same number for the same route + slot every day (LH 401, LH 403, …).
 * We mirror that: base derived from route id, offset by slot.
 */
export function flightNumberFor(routeId: number, slotIndex: number): string {
  const base = 100 + ((routeId * 17 + 3) % 800);
  const number = base + slotIndex * 2;
  return `FL${String(number).padStart(3, "0")}`;
}
