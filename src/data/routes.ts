// Route catalog. Two hubs (LHR, SFO) each fly to every other airport.
// Aircraft selection is by haul. Duration and base fare are derived from the
// marketing site's tables; haul is automatic at 6h.

import { airports, type SeedAirport } from "./airports.js";

export type SeedRoute = {
  fromIata: string;
  toIata: string;
  durationMin: number;
  fareFromEur: number;
  freqPerWeek: number;
  haul: "short" | "long";
  defaultAircraft: string;
};

// Duration table copied from flylo-air/web/src/data/destinations.ts for LHR
// outbound. SFO outbound is derived (transatlantic flips, transpacific
// shrinks, etc) using rough great-circle approximations.
const lhrDurations: Record<string, number> = {
  CDG:  80, AMS:  85, BCN: 130, CPH: 125, FCO: 155, LIS: 175, IST: 240, ATH: 210,
  JFK: 440, SFO: 675, HND: 720, SIN: 790, DXB: 420, GRU: 710, SYD: 1260, JNB: 655,
};

const sfoDurations: Record<string, number> = {
  // West-bound transpacific
  HND: 660, SIN: 1020,
  // East-bound transatlantic and others (longer than LHR equivalents)
  CDG: 645, AMS: 645, BCN: 685, CPH: 615, FCO: 720, LIS: 660, IST: 800, ATH: 780,
  JFK: 360, DXB: 935, GRU: 765, SYD: 945, JNB: 1080,
  // Hub-to-hub
  LHR: 675,
};

const baseFares: Record<string, number> = {
  CDG: 140, AMS: 120, BCN: 160, CPH: 175, FCO: 180, LIS: 195, IST: 220, ATH: 210,
  JFK: 690, HND: 980, SIN: 1020, DXB: 640, GRU: 920, SYD: 1480, JNB: 860,
  LHR: 880, SFO: 880,
};

// Reasonable frequency targets. Hub-to-hub gets daily; major Europe daily-ish;
// longest routes a few times a week.
const freqTargets: Record<string, number> = {
  CDG: 35, AMS: 28, BCN: 21, CPH: 21, FCO: 18, LIS: 14, IST: 14, ATH: 14,
  JFK: 14, SFO: 7,  HND: 7,  SIN: 7,  DXB: 14, GRU: 5,  SYD: 4,  JNB: 5,
  LHR: 7,
};

function pickAircraft(durationMin: number): string {
  if (durationMin <= 200) return "A220";
  if (durationMin <= 360) return "A321XLR";
  if (durationMin <= 700) return "A350-900";
  return "A350-1000";
}

function buildRoutesFromHub(hub: SeedAirport, durations: Record<string, number>): SeedRoute[] {
  return airports
    .filter((airport) => airport.iata !== hub.iata && durations[airport.iata] != null)
    .map((airport) => {
      const durationMin = durations[airport.iata]!;
      const fareFromEur = baseFares[airport.iata] ?? 200;
      const freqPerWeek = freqTargets[airport.iata] ?? 7;
      const haul: "short" | "long" = durationMin > 360 ? "long" : "short";
      return {
        fromIata: hub.iata,
        toIata: airport.iata,
        durationMin,
        fareFromEur,
        freqPerWeek,
        haul,
        defaultAircraft: pickAircraft(durationMin),
      };
    });
}

const lhr = airports.find((airport) => airport.iata === "LHR")!;
const sfo = airports.find((airport) => airport.iata === "SFO")!;

export const routes: SeedRoute[] = [
  ...buildRoutesFromHub(lhr, lhrDurations),
  ...buildRoutesFromHub(sfo, sfoDurations),
];
