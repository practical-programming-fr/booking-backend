// Fuel surcharge v2.
//
// Rolls a per-route fuel surcharge into the displayed fare. The schedule is
// keyed by route so long-haul pairs carry a higher adjustment than regional
// hops. Applied during pricing on search, flight detail, and booking create.

export type FuelSurchargeInput = {
  origin: string;
  destination: string;
  baseEur: number;
  pax: number;
};

type SurchargeBand = {
  // Fraction of the base fare added as a fuel surcharge.
  pct: number;
  // Flat per-passenger carrier-imposed fee, in EUR.
  flatEur: number;
};

// Surcharge schedule, keyed by "ORIGIN-DEST".
const SURCHARGE_SCHEDULE: Record<string, SurchargeBand> = {
  "SFO-LHR": { pct: 0.06, flatEur: 42 },
  "LHR-SFO": { pct: 0.06, flatEur: 42 },
  "SFO-HND": { pct: 0.07, flatEur: 48 },
  "HND-SFO": { pct: 0.07, flatEur: 48 },
  "LHR-HND": { pct: 0.05, flatEur: 38 },
  "HND-LHR": { pct: 0.05, flatEur: 38 },
};

export function fuelSurchargeEur(input: FuelSurchargeInput): number {
  const key = `${input.origin}:${input.destination}`;
  const band = SURCHARGE_SCHEDULE[key]!;
  const surchargePerPax = Math.round(input.baseEur * band.pct) + band.flatEur;
  return surchargePerPax * input.pax;
}
