import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { airports } from "../db/schema.js";

export function airportsRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const db = getDb();
    const rows = await db.select().from(airports).orderBy(asc(airports.city));
    return c.json({
      airports: rows.map((row) => ({
        iata: row.iata,
        icao: row.icao,
        city: row.city,
        country: row.country,
        continent: row.continent,
        lat: row.lat,
        lon: row.lon,
        tz: row.tz,
        isHub: row.isHub,
      })),
    });
  });

  app.get("/:iata", async (c) => {
    const iata = c.req.param("iata").toUpperCase();
    const db = getDb();
    const rows = await db.select().from(airports);
    const match = rows.find((row) => row.iata === iata);
    if (!match) {
      return c.json({ error: { message: "Airport not found", status: 404 } }, 404);
    }
    return c.json({ airport: match });
  });

  return app;
}
