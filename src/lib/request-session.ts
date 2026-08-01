import { z } from "zod";
import { loadEnv } from "../env.js";

type HeaderRequest = {
  req: { header: (name: string) => string | undefined };
};

const bookingSessionSchema = z.string().uuid();

export function bookingSessionIdFrom(request: HeaderRequest): string | undefined {
  const raw = request.req.header(loadEnv().BOOKING_SESSION_HEADER.toLowerCase());
  const parsed = bookingSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function demoSessionIdFrom(request: HeaderRequest): string | undefined {
  const raw = request.req.header(loadEnv().DEMO_SESSION_HEADER.toLowerCase());
  return raw && raw.length > 0 ? raw : undefined;
}
