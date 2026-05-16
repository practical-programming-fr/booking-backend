// Mirrors flylo-air/web/src/data/fleet.ts.

export type SeedAircraft = {
  code: string;
  model: string;
  seats: number;
  rangeKm: number;
  cruiseKmh: number;
  introducedYear: number;
  role: "short" | "long";
  note: string;
};

export const aircraftTypes: SeedAircraft[] = [
  {
    code: "A220",
    model: "Airbus A220-300",
    seats: 132,
    rangeKm: 6_300,
    cruiseKmh: 870,
    introducedYear: 2023,
    role: "short",
    note: "The quietest single-aisle in service. City pairs under 3h.",
  },
  {
    code: "A321XLR",
    model: "Airbus A321XLR",
    seats: 180,
    rangeKm: 8_700,
    cruiseKmh: 870,
    introducedYear: 2024,
    role: "short",
    note: "Thin long-haul: San Francisco to the east coast on a single aisle.",
  },
  {
    code: "A350-900",
    model: "Airbus A350-900",
    seats: 296,
    rangeKm: 15_000,
    cruiseKmh: 910,
    introducedYear: 2022,
    role: "long",
    note: "Workhorse of the long-haul fleet. 25% lower fuel burn than predecessors.",
  },
  {
    code: "A350-1000",
    model: "Airbus A350-1000",
    seats: 336,
    rangeKm: 16_100,
    cruiseKmh: 910,
    introducedYear: 2024,
    role: "long",
    note: "Ultra-long range. SYD, GRU, SFO. Cabin altitude 1,830 m.",
  },
];
