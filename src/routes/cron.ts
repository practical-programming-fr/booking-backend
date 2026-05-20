import { Hono } from "hono";
import { getSql } from "../db/client.js";
import { sweepExpiredHolds } from "../domain/cron.js";

export function cronRoutes(): Hono {
  const app = new Hono();

  // POST so accidental browser GETs don't trigger sweeps. Vercel Cron
  // configured in vercel.json hits this every minute.
  //
  // If CRON_SECRET is set in the environment, require it as a Bearer
  // header (Vercel Cron sends `Authorization: Bearer <secret>`). In dev
  // the env is unset so the endpoint is open — fine for localhost.
  app.post("/release-expired-holds", async (c) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const provided = c.req.header("authorization");
      if (provided !== `Bearer ${expected}`) {
        return c.json({ error: { message: "Unauthorised", status: 401 } }, 401);
      }
    }
    const sql = getSql();
    const result = await sweepExpiredHolds(sql);
    return c.json({ ok: true, ...result });
  });

  // Vercel Cron emits GET. Accept both so the platform's default scheduler
  // works without forcing a method change.
  app.get("/release-expired-holds", async (c) => {
    const expected = process.env.CRON_SECRET;
    if (expected) {
      const provided = c.req.header("authorization");
      if (provided !== `Bearer ${expected}`) {
        return c.json({ error: { message: "Unauthorised", status: 401 } }, 401);
      }
    }
    const sql = getSql();
    const result = await sweepExpiredHolds(sql);
    return c.json({ ok: true, ...result });
  });

  return app;
}
