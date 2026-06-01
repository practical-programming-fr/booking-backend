import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, asc, between, eq, gte, sql } from "drizzle-orm";
import { getDb, getSql } from "../db/client.js";
import {
  aircraftTypes,
  airports,
  cabins,
  flightFares,
  flightSeats,
  flights,
  routes,
  seatMapTemplates,
} from "../db/schema.js";
import { loadFlightBriefing, loadFlightManifest } from "../domain/manifest.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const searchSchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  date: isoDate,
  pax: z.coerce.number().int().min(1).max(9).optional().default(1),
  cabin: z.enum(["A", "P", "L"]).optional(),
});

const calendarSchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM"),
  cabin: z.enum(["A", "P", "L"]).optional().default("L"),
});

const seatMapSchema = z.object({
  cabin: z.enum(["A", "P", "L"]),
});

const flightIdSchema = z.string().uuid();

export function flightsRoutes(): Hono {
  const app = new Hono();

  // --- /v1/flights/search ----------------------------------------------------
  app.get("/search", zValidator("query", searchSchema), async (c) => {
    const { from, to, date, pax, cabin } = c.req.valid("query");
    const db = getDb();

    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(`${date}T23:59:59Z`);

    const matchingRoutes = await db
      .select()
      .from(routes)
      .where(
        and(
          eq(routes.fromIata, from.toUpperCase()),
          eq(routes.toIata, to.toUpperCase()),
        ),
      );
    if (matchingRoutes.length === 0) {
      return c.json({
        from,
        to,
        date,
        pax,
        cabin,
        results: [],
      });
    }

    const route = matchingRoutes[0]!;

    const rows = await db
      .select({
        flight: flights,
        fare: flightFares,
      })
      .from(flights)
      .leftJoin(flightFares, eq(flightFares.flightId, flights.id))
      .where(
        and(
          eq(flights.routeId, route.id),
          between(flights.departAt, dayStart, dayEnd),
          cabin ? eq(flightFares.cabin, cabin) : undefined,
        ),
      )
      .orderBy(asc(flights.departAt));

    type FareRow = typeof flightFares.$inferSelect;
    type Group = {
      flight: typeof flights.$inferSelect;
      fares: FareRow[];
    };
    const grouped = new Map<string, Group>();

    for (const row of rows) {
      const id = row.flight.id;
      let group = grouped.get(id);
      if (!group) {
        group = { flight: row.flight, fares: [] };
        grouped.set(id, group);
      }
      if (row.fare) {
        group.fares.push(row.fare);
      }
    }

    const results = [...grouped.values()].map(({ flight, fares }) => {
      const cabinOrder: Array<"A" | "P" | "L"> = ["A", "P", "L"];
      const sortedFares = fares
        .filter((fare) => cabinOrder.includes(fare.cabin as "A" | "P" | "L"))
        .sort(
          (a, b) =>
            cabinOrder.indexOf(a.cabin as "A" | "P" | "L") -
            cabinOrder.indexOf(b.cabin as "A" | "P" | "L"),
        );

      const cheapestFare = [...sortedFares].sort(
        (a, b) => a.baseEur - b.baseEur,
      )[0];

      return {
        id: flight.id,
        flightNo: flight.flightNo,
        aircraft: flight.aircraftType,
        from: route.fromIata,
        to: route.toIata,
        departAt: flight.departAt.toISOString(),
        arriveAt: flight.arriveAt.toISOString(),
        durationMin: flight.durationMin,
        status: flight.status,
        fares: sortedFares.map((fare) => ({
          cabin: fare.cabin,
          baseEur: fare.baseEur,
          totalForPaxEur: fare.baseEur * pax,
          seatsAvailable: fare.seatsAvailable,
        })),
        cheapestFromEur: cheapestFare?.baseEur ?? null,
      };
    });

    return c.json({ from, to, date, pax, cabin, results });
  });

  // --- /v1/flights/calendar --------------------------------------------------
  app.get("/calendar", zValidator("query", calendarSchema), async (c) => {
    const { from, to, month, cabin } = c.req.valid("query");
    const db = getDb();

    const [year, monthNum] = month.split("-").map((value) => Number.parseInt(value, 10));
    if (!year || !monthNum) {
      return c.json({ error: { message: "Invalid month", status: 400 } }, 400);
    }
    const monthStart = new Date(Date.UTC(year, monthNum - 1, 1));
    const monthEnd = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59));

    const matchingRoutes = await db
      .select()
      .from(routes)
      .where(
        and(
          eq(routes.fromIata, from.toUpperCase()),
          eq(routes.toIata, to.toUpperCase()),
        ),
      );
    if (matchingRoutes.length === 0) {
      return c.json({ from, to, month, cabin, days: [] });
    }

    const route = matchingRoutes[0]!;

    const rows = await db
      .select({
        date: sql<string>`to_char(${flights.departAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        minBase: sql<number>`min(${flightFares.baseEur})`,
        flightCount: sql<number>`count(distinct ${flights.id})`,
      })
      .from(flights)
      .innerJoin(flightFares, eq(flightFares.flightId, flights.id))
      .where(
        and(
          eq(flights.routeId, route.id),
          eq(flightFares.cabin, cabin),
          between(flights.departAt, monthStart, monthEnd),
        ),
      )
      .groupBy(
        sql`to_char(${flights.departAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      );

    return c.json({
      from,
      to,
      month,
      cabin,
      days: rows.map((row) => ({
        date: row.date,
        fromEur: Number(row.minBase),
        flights: Number(row.flightCount),
      })),
    });
  });

  // --- /v1/flights/:id/manifest ---------------------------------------------
  app.get("/:id/manifest", async (c) => {
    const parsed = flightIdSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: { message: "Invalid flight id", status: 400 } }, 400);
    }

    const manifest = await loadFlightManifest(getSql(), parsed.data);
    if (!manifest) {
      return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
    }

    return c.json({ manifest });
  });

  // --- /v1/flights/:id/briefing ---------------------------------------------
  app.get("/:id/briefing", async (c) => {
    const parsed = flightIdSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: { message: "Invalid flight id", status: 400 } }, 400);
    }

    const briefing = await loadFlightBriefing(getSql(), parsed.data);
    if (!briefing) {
      return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
    }

    return c.json({ briefing });
  });

  // --- /v1/flights/:id -------------------------------------------------------
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb();

    const rows = await db
      .select({
        flight: flights,
        route: routes,
        aircraft: aircraftTypes,
        fromAirport: {
          iata: sql<string>`from_air.iata`,
          city: sql<string>`from_air.city`,
          country: sql<string>`from_air.country`,
          tz: sql<string>`from_air.tz`,
        },
        toAirport: {
          iata: sql<string>`to_air.iata`,
          city: sql<string>`to_air.city`,
          country: sql<string>`to_air.country`,
          tz: sql<string>`to_air.tz`,
        },
      })
      .from(flights)
      .innerJoin(routes, eq(routes.id, flights.routeId))
      .innerJoin(aircraftTypes, eq(aircraftTypes.code, flights.aircraftType))
      .innerJoin(
        sql`${airports} as from_air`,
        sql`from_air.iata = ${routes.fromIata}`,
      )
      .innerJoin(
        sql`${airports} as to_air`,
        sql`to_air.iata = ${routes.toIata}`,
      )
      .where(eq(flights.id, id));

    if (rows.length === 0) {
      return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
    }

    const row = rows[0]!;

    const fareRows = await db
      .select({
        fare: flightFares,
        cabin: cabins,
      })
      .from(flightFares)
      .innerJoin(cabins, eq(cabins.code, flightFares.cabin))
      .where(eq(flightFares.flightId, id))
      .orderBy(asc(cabins.sortOrder));

    return c.json({
      flight: {
        id: row.flight.id,
        flightNo: row.flight.flightNo,
        status: row.flight.status,
        departAt: row.flight.departAt.toISOString(),
        arriveAt: row.flight.arriveAt.toISOString(),
        durationMin: row.flight.durationMin,
        aircraft: {
          code: row.aircraft.code,
          model: row.aircraft.model,
          seats: row.aircraft.seats,
          rangeKm: row.aircraft.rangeKm,
          cruiseKmh: row.aircraft.cruiseKmh,
          note: row.aircraft.note,
        },
        from: row.fromAirport,
        to: row.toAirport,
        route: {
          haul: row.route.haul,
          freqPerWeek: row.route.freqPerWeek,
        },
        fares: fareRows.map(({ fare, cabin }) => ({
          cabin: cabin.code,
          cabinName: cabin.name,
          deck: cabin.deck,
          dining: cabin.dining,
          baseEur: fare.baseEur,
          taxesEur: fare.taxesEur,
          surfaceEur: fare.surfaceEur,
          seatsTotal: fare.seatsTotal,
          seatsAvailable: fare.seatsAvailable,
        })),
      },
    });
  });

  // --- /v1/flights/:id/seat-map ---------------------------------------------
  app.get("/:id/seat-map", zValidator("query", seatMapSchema), async (c) => {
    const id = c.req.param("id");
    const { cabin } = c.req.valid("query");
    const db = getDb();

    const flightRows = await db
      .select()
      .from(flights)
      .where(eq(flights.id, id));
    if (flightRows.length === 0) {
      return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
    }
    const flight = flightRows[0]!;

    const [layoutRow] = await db
      .select()
      .from(seatMapTemplates)
      .where(
        and(
          eq(seatMapTemplates.aircraftType, flight.aircraftType),
          eq(seatMapTemplates.cabin, cabin),
        ),
      );
    if (!layoutRow) {
      return c.json(
        { error: { message: "No seat map for this cabin on this aircraft", status: 404 } },
        404,
      );
    }

    const seats = await db
      .select()
      .from(flightSeats)
      .where(
        and(
          eq(flightSeats.flightId, id),
          eq(flightSeats.cabin, cabin),
        ),
      );

    const holds = await db
      .select()
      .from(flightSeats)
      .where(
        and(
          eq(flightSeats.flightId, id),
          eq(flightSeats.cabin, cabin),
          gte(flightSeats.priceEur, 0),
        ),
      )
      .limit(0); // placeholder for seat_holds join in next iteration

    return c.json({
      flight: {
        id: flight.id,
        flightNo: flight.flightNo,
        aircraft: flight.aircraftType,
      },
      cabin,
      layout: layoutRow.layout,
      seats: seats.map((seat) => ({
        seatId: seat.seatId,
        zone: seat.zone,
        priceEur: seat.priceEur,
        status: seat.status,
      })),
      // Reserved for the next iteration when seat_holds are wired in.
      holds: holds.map(() => null),
    });
  });

  return app;
}
