import { Hono } from "hono";
import { getSql } from "../db/client.js";

export function healthRoutes(): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    let dbOk = false;
    let dbError: string | undefined;
    try {
      const sql = getSql();
      const [row] = await sql`select 1 as ok`;
      dbOk = row?.ok === 1;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }

    return c.json({
      status: dbOk ? "ok" : "degraded",
      service: "flylo-booking-backend",
      time: new Date().toISOString(),
      db: dbOk ? { status: "ok" } : { status: "error", error: dbError },
    });
  });

  return app;
}
