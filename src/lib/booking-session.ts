import type { Context } from "hono";
import { z } from "zod";
import { loadEnv } from "../env.js";

const bookingSessionSchema = z.string().uuid();

export function readBookingSessionId(c: Context): string | null {
  const headerName = loadEnv().BOOKING_SESSION_HEADER.toLowerCase();
  const parsed = bookingSessionSchema.safeParse(c.req.header(headerName));
  return parsed.success ? parsed.data : null;
}
