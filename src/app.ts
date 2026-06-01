import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { loadEnv } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { airportsRoutes } from "./routes/airports.js";
import { routesRoutes } from "./routes/routes.js";
import { flightsRoutes } from "./routes/flights.js";
import { bookingsRoutes } from "./routes/bookings.js";
import { meRoutes } from "./routes/me.js";
import { cronRoutes } from "./routes/cron.js";
import { mcpRoutes } from "./routes/mcp.js";

export function buildApp(): Hono {
  const env = loadEnv();
  const app = new Hono();

  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.BOOKING_ALLOWED_ORIGINS[0] ?? "*";
        return env.BOOKING_ALLOWED_ORIGINS.includes(origin) ? origin : null;
      },
      allowHeaders: [
        "Content-Type",
        "Authorization",
        env.BOOKING_SESSION_HEADER,
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
      ],
      exposeHeaders: ["x-request-id", "Mcp-Session-Id"],
      credentials: true,
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    console.error("[booking-backend]", err);
    const status = (err as { status?: number }).status ?? 500;
    return c.json(
      {
        error: {
          message: status === 500 ? "Internal server error" : err.message,
          status,
        },
      },
      status as 400 | 401 | 403 | 404 | 409 | 422 | 500,
    );
  });

  app.notFound((c) =>
    c.json({ error: { message: "Not found", status: 404 } }, 404),
  );

  const v1 = new Hono();
  v1.route("/", healthRoutes());
  v1.route("/airports", airportsRoutes());
  v1.route("/routes", routesRoutes());
  v1.route("/flights", flightsRoutes());
  v1.route("/bookings", bookingsRoutes());
  v1.route("/me", meRoutes());
  v1.route("/_cron", cronRoutes());

  app.route("/v1", v1);
  app.route("/mcp", mcpRoutes({
    internalFetch: async (path, init) => app.request(path, init),
  }));
  app.get("/", (c) =>
    c.json({
      name: "flylo-booking-backend",
      version: "0.1.0",
      docs: "/v1/health",
    }),
  );

  return app;
}
