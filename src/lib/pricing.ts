// Pricing primitives. Kept tiny on purpose — the booking flow only ever
// touches `flight_fares.base_eur` and the per-seat / per-meal extras.

export type FareInput = {
  baseEur: number;
  pax: number;
  seatsEur: number;
  mealsEur: number;
  taxesEur: number;
  surfaceEurPerPax: number;
};

export type FareBreakdown = {
  baseEur: number;
  seatsEur: number;
  mealsEur: number;
  taxesEur: number;
  surfaceEur: number;
  totalEur: number;
};

export function computeFare(input: FareInput): FareBreakdown {
  const base = input.baseEur * input.pax;
  const taxes = Math.round(base * 0.14) + input.taxesEur;
  const surface = input.surfaceEurPerPax * input.pax;
  const total =
    base + input.seatsEur + input.mealsEur + taxes + surface;

  return {
    baseEur: base,
    seatsEur: input.seatsEur,
    mealsEur: input.mealsEur,
    taxesEur: taxes,
    surfaceEur: surface,
    totalEur: total,
  };
}

// Per-flight jitter so successive days vary realistically. Deterministic
// from a stable seed (e.g. flight number + ISO date) so the same flight
// always shows the same price.
export function priceJitter(seed: string): number {
  let hash = 7;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) & 0xffffffff;
  }
  const normalised = (Math.abs(hash) % 1000) / 1000;
  // ±18% swing, centered on 1.0
  return 0.82 + normalised * 0.36;
}
