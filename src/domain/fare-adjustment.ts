// Fuel surcharge v2.
//
// Rolls a per-route fuel surcharge into the displayed fare. The schedule is
// keyed "ORIGIN-DEST": long-haul pairs carry a higher adjustment than
// regional hops, and a route with no band contributes 0. Applied during
// pricing on search, flight detail, booking create, and total recompute,
// and only while the fare_adjustment_v2 outage is active for the request.

import type postgres from "postgres";
import { isOutageActiveForRequest } from "./ops.js";

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

function routeKey(origin: string, destination: string): string {
  return `${origin.trim().toUpperCase()}-${destination.trim().toUpperCase()}`;
}

// Band amount for one fare. Routes that are not on the schedule add nothing;
// a missing band must not fail search or checkout.
function scheduledFuelSurchargeEur(input: FuelSurchargeInput): number {
  const band = SURCHARGE_SCHEDULE[routeKey(input.origin, input.destination)];
  if (!band) return 0;
  const surchargePerPax = Math.round(input.baseEur * band.pct) + band.flatEur;
  return surchargePerPax * input.pax;
}

export type FuelSurchargeQuote = (input: FuelSurchargeInput) => number;

// One pricing gate for search, flight detail, draft create, and totals.
// The returned quote is 0 for every route unless this request is inside the
// global fare_adjustment_v2 outage or a scoped run.
export async function fuelSurchargeForRequest(
  sql: postgres.Sql,
  identity: {
    demoSessionId?: string;
    bookingSessionId?: string;
  },
): Promise<FuelSurchargeQuote> {
  const outageActive = await isOutageActiveForRequest(sql, identity);
  if (!outageActive) {
    return () => 0;
  }
  return (input) => scheduledFuelSurchargeEur(input);
}
