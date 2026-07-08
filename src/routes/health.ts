import { Hono } from "hono";
import { getSql } from "../db/client.js";

// Captured at module load (build / cold start) so the value is baked into the
// serverless bundle. VERCEL_GIT_COMMIT_SHA is a full 40-char SHA that is most
// reliable at build time and may be unset inside the request handler.
const COMMIT_SHA =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? null;

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
      commit: COMMIT_SHA,
      time: new Date().toISOString(),
      db: dbOk ? { status: "ok" } : { status: "error", error: dbError },
    });
  });

  return app;
}
