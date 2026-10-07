// Pricing for the routes customers could not book: SFO-LHR both ways, and
// Paris (CDG)-London both ways. The surcharge is quoted once per request and
// shared by search, flight detail, and draft create. Flag off keeps today's
// fares. Flag on adds the schedule, or 0 when the route has no band.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createDraftBooking } from "../src/domain/booking.js";
import { fuelSurchargeForRequest } from "../src/domain/fare-adjustment.js";
import { recomputeBookingTotals } from "../src/domain/totals.js";
import {
  FARE_ADJUSTMENT_FLAG,
  setFlag,
} from "../src/domain/ops.js";
import { isValidPnr } from "../src/lib/pnr.js";

const BASE_EUR = 1000;
const TAXES_EUR = 140;
const SURFACE_EUR = 25;
const PAX = 2;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FLIGHT_ID = "00000000-0000-4000-8000-0000000000aa";
const DEPART_AT = new Date("2026-10-20T10:00:00Z");
const ARRIVE_AT = new Date("2026-10-20T18:05:00Z");

// round(1000 * 0.06) + 42. CDG-LHR has no schedule band.
const ROUTES = [
  { origin: "SFO", destination: "LHR", bandPerPax: 102 },
  { origin: "LHR", destination: "SFO", bandPerPax: 102 },
  { origin: "CDG", destination: "LHR", bandPerPax: 0 },
  { origin: "LHR", destination: "CDG", bandPerPax: 0 },
] as const;

type DraftInsert = {
  baseEur: number;
  taxesEur: number;
  surfaceEur: number;
  totalEur: number;
};

type Recomputed = {
  baseEur: number;
  taxesEur: number;
  surfaceEur: number;
  totalEur: number;
};

const fake = vi.hoisted(() => {
  const flags = new Map<string, boolean>();
  const dbQueue: unknown[][] = [];
  const drafts: DraftInsert[] = [];
  let recomputed: Recomputed | null = null;
  let fare: {
    from_iata: string;
    to_iata: string;
    base_eur: number;
    taxes_eur: number;
    surface_eur: number;
  } | null = null;

  function queryResult(rows: unknown[]) {
    const builder: {
      from: () => typeof builder;
      where: () => typeof builder;
      leftJoin: () => typeof builder;
      innerJoin: () => typeof builder;
      orderBy: () => typeof builder;
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise<unknown>;
    } = {
      from: () => builder,
      where: () => builder,
      leftJoin: () => builder,
      innerJoin: () => builder,
      orderBy: () => builder,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  }

  function isTemplateStrings(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && "raw" in value;
  }

  function handleQuery(strings: TemplateStringsArray, values: unknown[]) {
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();

    if (text.startsWith("insert into public.ops_flags")) {
      flags.set(values[0] as string, values[1] as boolean);
      return Promise.resolve([]);
    }
    if (text.includes("from public.ops_flags")) {
      const enabled = flags.get(values[0] as string);
      return Promise.resolve(enabled === undefined ? [] : [{ enabled }]);
    }
    if (text.includes("ops_demo_outages")) {
      return Promise.resolve([]);
    }
    if (text.includes("from public.booking_segments")) {
      return Promise.resolve(
        fare
          ? [
              {
                cabin: "L",
                base_eur: fare.base_eur,
                taxes_eur: fare.taxes_eur,
                surface_eur: fare.surface_eur,
                from_iata: fare.from_iata,
                to_iata: fare.to_iata,
              },
            ]
          : [],
      );
    }
    if (text.includes("from public.flight_fares")) {
      return Promise.resolve(
        fare
          ? [
              {
                flight_id: FLIGHT_ID,
                cabin: "L",
                base_eur: fare.base_eur,
                taxes_eur: fare.taxes_eur,
                surface_eur: fare.surface_eur,
                seats_available: 9,
                depart_at: new Date("2099-01-01T00:00:00Z"),
                from_iata: fare.from_iata,
                to_iata: fare.to_iata,
              },
            ]
          : [],
      );
    }
    if (text.includes("select pax, promo_code, session_id")) {
      return Promise.resolve([
        { pax: PAX, promo_code: null, session_id: SESSION_ID },
      ]);
    }
    if (text.includes("from public.bookings where pnr")) {
      return Promise.resolve([]);
    }
    if (text.startsWith("insert into public.bookings")) {
      drafts.push({
        baseEur: values[4] as number,
        taxesEur: values[5] as number,
        surfaceEur: values[6] as number,
        totalEur: values[7] as number,
      });
      return Promise.resolve([]);
    }
    if (
      text.startsWith("insert into public.booking_segments") ||
      text.startsWith("insert into public.passengers") ||
      text.startsWith("update public.flight_fares")
    ) {
      return Promise.resolve([]);
    }
    if (text.includes("as seats_eur")) {
      return Promise.resolve([{ seats_eur: 0 }]);
    }
    if (text.includes("as meals_eur")) {
      return Promise.resolve([{ meals_eur: 0 }]);
    }
    if (text.startsWith("update public.bookings")) {
      recomputed = {
        baseEur: values[0] as number,
        taxesEur: values[3] as number,
        surfaceEur: values[4] as number,
        totalEur: values[6] as number,
      };
      return Promise.resolve([]);
    }

    return Promise.reject(new Error(`Unhandled query in fake sql: ${text}`));
  }

  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (isTemplateStrings(first)) {
      return handleQuery(first, rest);
    }
    return { fragment: true };
  }) as unknown as import("postgres").Sql;
  const mutable = sql as unknown as {
    begin: (fn: (tx: import("postgres").Sql) => Promise<unknown>) => Promise<unknown>;
    json: (value: unknown) => unknown;
  };
  mutable.begin = (fn) => fn(sql);
  mutable.json = (value) => value;

  return {
    sql,
    dbQueue,
    drafts,
    flags,
    queryResult,
    get recomputed() {
      return recomputed;
    },
    set recomputed(value: Recomputed | null) {
      recomputed = value;
    },
    setFare(origin: string, destination: string) {
      fare = {
        from_iata: origin,
        to_iata: destination,
        base_eur: BASE_EUR,
        taxes_eur: TAXES_EUR,
        surface_eur: SURFACE_EUR,
      };
    },
  };
});

vi.mock("../src/db/client.js", () => ({
  getSql: () => fake.sql,
  getDb: () => ({
    select: () => fake.queryResult(fake.dbQueue.shift() ?? []),
  }),
}));

function stubEnv() {
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "sb_publishable_stub";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "sb_secret_stub";
}

function queueSearch(origin: string, destination: string) {
  fake.dbQueue.push([
    { id: 1, fromIata: origin, toIata: destination },
  ]);
  fake.dbQueue.push([
    {
      flight: {
        id: FLIGHT_ID,
        flightNo: "FL100",
        aircraftType: "A350-900",
        departAt: DEPART_AT,
        arriveAt: ARRIVE_AT,
        durationMin: 485,
        status: "scheduled",
      },
      fare: {
        cabin: "L",
        baseEur: BASE_EUR,
        seatsAvailable: 9,
      },
    },
  ]);
}

function queueFlightDetail(origin: string, destination: string) {
  fake.dbQueue.push([
    {
      flight: {
        id: FLIGHT_ID,
        flightNo: "FL100",
        status: "scheduled",
        departAt: DEPART_AT,
        arriveAt: ARRIVE_AT,
        durationMin: 485,
      },
      aircraft: {
        code: "A350-900",
        model: "Airbus A350-900",
        seats: 331,
        rangeKm: 15000,
        cruiseKmh: 910,
        note: null,
      },
      fromAirport: { iata: origin, city: origin, country: "X", tz: "UTC" },
      toAirport: { iata: destination, city: destination, country: "Y", tz: "UTC" },
      route: { haul: "long", freqPerWeek: 7 },
    },
  ]);
  fake.dbQueue.push([
    {
      fare: {
        baseEur: BASE_EUR,
        taxesEur: TAXES_EUR,
        surfaceEur: SURFACE_EUR,
        seatsTotal: 200,
        seatsAvailable: 9,
      },
      cabin: { code: "L", name: "Leisure", deck: "main", dining: "standard" },
    },
  ]);
}

describe("fare adjustment", () => {
  let app: Hono;

  beforeAll(async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    app = buildApp();
  });

  beforeEach(() => {
    fake.dbQueue.length = 0;
    fake.drafts.length = 0;
    fake.recomputed = null;
  });

  it("reads the ORIGIN-DEST band when iata values are padded or lower case", async () => {
    await setFlag(fake.sql, FARE_ADJUSTMENT_FLAG, true);
    const quote = await fuelSurchargeForRequest(fake.sql, {});
    expect(
      quote({ origin: "sfo", destination: "lhr", baseEur: BASE_EUR, pax: 1 }),
    ).toBe(102);
    expect(
      quote({ origin: "SFO ", destination: " LHR", baseEur: BASE_EUR, pax: 1 }),
    ).toBe(102);
    expect(
      quote({ origin: "CDG", destination: "LHR", baseEur: BASE_EUR, pax: 1 }),
    ).toBe(0);
  });

  for (const route of ROUTES) {
    for (const flagOn of [false, true]) {
      const label = `${route.origin}-${route.destination} flag ${flagOn ? "on" : "off"}`;
      const perPax = flagOn ? route.bandPerPax : 0;

      it(`${label}: search total, flight-detail surcharge, and draft fuel`, async () => {
        await setFlag(fake.sql, FARE_ADJUSTMENT_FLAG, flagOn);
        fake.setFare(route.origin, route.destination);

        queueSearch(route.origin, route.destination);
        const searchRes = await app.request(
          `/v1/flights/search?from=${route.origin}&to=${route.destination}&date=2026-10-20&pax=${PAX}`,
        );
        expect(searchRes.status).toBe(200);
        const search = (await searchRes.json()) as {
          results: Array<{ fares: Array<{ totalForPaxEur: number }> }>;
        };
        expect(search.results).toHaveLength(1);
        expect(search.results[0]!.fares[0]!.totalForPaxEur).toBe(
          BASE_EUR * PAX + perPax * PAX,
        );

        queueFlightDetail(route.origin, route.destination);
        const detailRes = await app.request(`/v1/flights/${FLIGHT_ID}`);
        expect(detailRes.status).toBe(200);
        const detail = (await detailRes.json()) as {
          flight: { fares: Array<{ fuelSurchargeEur: number }> };
        };
        expect(detail.flight.fares[0]!.fuelSurchargeEur).toBe(perPax);

        const draft = await createDraftBooking(fake.sql, {
          flightId: FLIGHT_ID,
          cabin: "L",
          pax: PAX,
          sessionId: SESSION_ID,
        });
        expect(isValidPnr(draft.pnr)).toBe(true);
        expect(fake.drafts).toHaveLength(1);
        const inserted = fake.drafts[0]!;
        expect(inserted.baseEur).toBe(BASE_EUR * PAX);
        expect(inserted.taxesEur).toBe(TAXES_EUR * PAX);
        expect(inserted.surfaceEur).toBe(SURFACE_EUR * PAX);
        expect(
          inserted.totalEur - inserted.baseEur - inserted.taxesEur - inserted.surfaceEur,
        ).toBe(perPax * PAX);

        const totals = await recomputeBookingTotals(fake.sql, draft.pnr);
        expect(fake.recomputed).not.toBeNull();
        expect(
          totals.totalEur - totals.baseEur - totals.taxesEur - totals.surfaceEur,
        ).toBe(perPax * PAX);
      });
    }
  }
});
