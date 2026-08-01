import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getSql } from "../db/client.js";
import {
  bindDemoSessionToBooking,
  DemoSessionActivationError,
} from "../domain/ops.js";
import { bookingSessionIdFrom } from "../lib/request-session.js";

const activationSchema = z.object({
  token: z.string().min(32).max(200),
});

export function demoRoutes(): Hono {
  const app = new Hono();

  app.post("/activate", zValidator("json", activationSchema), async (c) => {
    const bookingSessionId = bookingSessionIdFrom(c);
    if (!bookingSessionId) {
      return c.json(
        {
          error: {
            code: "booking_session_required",
            message: "A valid x-booking-session header is required.",
            status: 400,
          },
        },
        400,
      );
    }

    try {
      const activation = await bindDemoSessionToBooking(getSql(), {
        activationToken: c.req.valid("json").token,
        bookingSessionId,
      });
      return c.json({ ok: true, ...activation });
    } catch (error) {
      if (error instanceof DemoSessionActivationError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
            },
          },
          error.status,
        );
      }
      throw error;
    }
  });

  return app;
}
