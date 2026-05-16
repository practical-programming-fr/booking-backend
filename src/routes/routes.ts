import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { routes } from "../db/schema.js";

const querySchema = z.object({
  from: z.string().length(3).optional(),
  to: z.string().length(3).optional(),
});

export function routesRoutes(): Hono {
  const app = new Hono();

  app.get("/", zValidator("query", querySchema), async (c) => {
    const { from, to } = c.req.valid("query");
    const db = getDb();

    const conditions = [];
    if (from) conditions.push(eq(routes.fromIata, from.toUpperCase()));
    if (to) conditions.push(eq(routes.toIata, to.toUpperCase()));

    const rows = await db
      .select()
      .from(routes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(routes.durationMin));

    return c.json({
      routes: rows.map((row) => ({
        id: row.id,
        from: row.fromIata,
        to: row.toIata,
        durationMin: row.durationMin,
        fareFromEur: row.fareFromEur,
        freqPerWeek: row.freqPerWeek,
        haul: row.haul,
        aircraft: row.defaultAircraft,
      })),
    });
  });

  return app;
}
