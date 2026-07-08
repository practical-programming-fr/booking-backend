import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getSql } from "../db/client.js";
import { loadEnv } from "../env.js";
import {
  assignMeals,
  createDraftBooking,
  DomainError,
  upsertPassengers,
  updateContact,
} from "../domain/booking.js";
import { assignSeats } from "../domain/seats.js";
import { confirmPayment, createPaymentIntent, cancelBooking } from "../domain/payments.js";
import { setBookingPromo } from "../domain/promo.js";
import { loadBooking } from "../domain/loader.js";

const sessionIdSchema = z.string().uuid("x-booking-session must be a UUID");

const createSchema = z.object({
  flightId: z.string().uuid(),
  cabin: z.enum(["A", "P", "L"]),
  pax: z.number().int().min(1).max(9),
  contact: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().email().max(120).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
});

const contactSchema = z.object({
  contact: z.object({
    name: z.string().max(120).optional(),
    email: z.string().email().max(120).optional(),
    phone: z.string().max(40).optional(),
  }),
});

const passengersSchema = z.object({
  passengers: z
    .array(
      z.object({
        passengerNo: z.number().int().min(1).max(9),
        givenName: z.string().min(1).max(80),
        familyName: z.string().min(1).max(80),
        loyaltyNo: z.string().max(40).nullable().optional(),
        notes: z.string().max(240).nullable().optional(),
      }),
    )
    .min(1)
    .max(9),
});

const seatsSchema = z.object({
  assignments: z
    .array(
      z.object({
        passengerNo: z.number().int().min(1).max(9),
        seatId: z.string().max(8).nullable(),
      }),
    )
    .min(1)
    .max(9),
});

const mealsSchema = z.object({
  assignments: z
    .array(
      z.object({
        passengerNo: z.number().int().min(1).max(9),
        mealId: z.string().min(1).max(40),
      }),
    )
    .min(1)
    .max(9),
});

const promoSchema = z.object({
  code: z.string().max(40).nullable().optional(),
});

const confirmSchema = z.object({
  paymentId: z.string().uuid(),
  card: z.object({
    cardholder: z.string().min(1).max(120),
    last4: z.string().regex(/^\d{4}$/),
    brand: z.string().max(40).optional(),
  }),
});

function getSessionId(c: Context): string | null {
  const env = loadEnv();
  const headerName = env.BOOKING_SESSION_HEADER.toLowerCase();
  const raw = c.req.header(headerName);
  if (!raw) return null;
  const parsed = sessionIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function handleDomainError(err: unknown):
  | { status: number; body: { error: { code: string; message: string; status: number } } }
  | null {
  if (err instanceof DomainError) {
    return {
      status: err.status,
      body: {
        error: { code: err.code, message: err.message, status: err.status },
      },
    };
  }
  return null;
}

export function bookingsRoutes(): Hono {
  const app = new Hono();

  // --- POST /v1/bookings ---------------------------------------------------
  app.post("/", zValidator("json", createSchema), async (c) => {
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json(
        { error: { message: "Missing x-booking-session", status: 400 } },
        400,
      );
    }
    try {
      const sql = getSql();
      const result = await createDraftBooking(sql, {
        flightId: c.req.valid("json").flightId,
        cabin: c.req.valid("json").cabin,
        pax: c.req.valid("json").pax,
        contact: c.req.valid("json").contact,
        sessionId,
      });
      if (c.req.valid("json").contact) {
        await updateContact(sql, result.pnr, c.req.valid("json").contact!);
      }
      const booking = await loadBooking(sql, result.pnr);
      return c.json({ booking }, 201);
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) {
        return c.json(mapped.body, mapped.status as 400);
      }
      throw err;
    }
  });

  // --- GET /v1/bookings/:pnr ----------------------------------------------
  app.get("/:pnr", async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    const email = c.req.query("email")?.trim().toLowerCase();

    const sql = getSql();
    const booking = await loadBooking(sql, pnr);
    if (!booking) {
      return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
    }

    // Owner via session, or guest via PNR + matching contact email.
    const ownerRow = (await sql`
      select session_id from public.bookings where pnr = ${pnr}
    `) as unknown as Array<{ session_id: string }>;
    const isOwner = sessionId && ownerRow[0]?.session_id === sessionId;
    const matchesEmail = email && booking.contact.email?.toLowerCase() === email;
    if (!isOwner && !matchesEmail) {
      return c.json(
        { error: { message: "Reservation found but the email does not match.", status: 403 } },
        403,
      );
    }

    return c.json({ booking });
  });

  // --- PATCH /v1/bookings/:pnr/contact ------------------------------------
  app.post("/:pnr/contact", zValidator("json", contactSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    const sql = getSql();
    const ownerRow = (await sql`
      select session_id, status from public.bookings where pnr = ${pnr}
    `) as unknown as Array<{ session_id: string; status: string }>;
    if (ownerRow.length === 0) {
      return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
    }
    if (ownerRow[0]!.session_id !== sessionId) {
      return c.json({ error: { message: "Not your booking", status: 403 } }, 403);
    }
    if (ownerRow[0]!.status === "cancelled" || ownerRow[0]!.status === "confirmed") {
      return c.json({ error: { message: "Booking is locked", status: 409 } }, 409);
    }
    await updateContact(sql, pnr, c.req.valid("json").contact);
    const booking = await loadBooking(sql, pnr);
    return c.json({ booking });
  });

  // --- POST /v1/bookings/:pnr/passengers ----------------------------------
  app.post("/:pnr/passengers", zValidator("json", passengersSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      const ownerRow = (await sql`
        select session_id from public.bookings where pnr = ${pnr}
      `) as unknown as Array<{ session_id: string }>;
      if (ownerRow.length === 0) {
        return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
      }
      if (ownerRow[0]!.session_id !== sessionId) {
        return c.json({ error: { message: "Not your booking", status: 403 } }, 403);
      }
      await upsertPassengers(sql, pnr, c.req.valid("json").passengers);
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/seats ----------------------------------------
  app.post("/:pnr/seats", zValidator("json", seatsSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      await assignSeats(sql, pnr, sessionId, c.req.valid("json").assignments);
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/meals ----------------------------------------
  app.post("/:pnr/meals", zValidator("json", mealsSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      const ownerRow = (await sql`
        select session_id from public.bookings where pnr = ${pnr}
      `) as unknown as Array<{ session_id: string }>;
      if (ownerRow.length === 0) {
        return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
      }
      if (ownerRow[0]!.session_id !== sessionId) {
        return c.json({ error: { message: "Not your booking", status: 403 } }, 403);
      }
      await assignMeals(sql, pnr, c.req.valid("json").assignments);
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/promo ---------------------------------------
  // Apply (or clear) a promo code. An empty/blank code clears any applied
  // promo, so a mis-entered code can be removed without a separate call.
  app.post("/:pnr/promo", zValidator("json", promoSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      const ownerRow = (await sql`
        select session_id from public.bookings where pnr = ${pnr}
      `) as unknown as Array<{ session_id: string }>;
      if (ownerRow.length === 0) {
        return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
      }
      if (ownerRow[0]!.session_id !== sessionId) {
        return c.json({ error: { message: "Not your booking", status: 403 } }, 403);
      }
      await setBookingPromo(sql, pnr, c.req.valid("json").code ?? null);
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- DELETE /v1/bookings/:pnr/promo -------------------------------------
  // Clear any applied promo and restore full price.
  app.delete("/:pnr/promo", async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      const ownerRow = (await sql`
        select session_id from public.bookings where pnr = ${pnr}
      `) as unknown as Array<{ session_id: string }>;
      if (ownerRow.length === 0) {
        return c.json({ error: { message: "Booking not found", status: 404 } }, 404);
      }
      if (ownerRow[0]!.session_id !== sessionId) {
        return c.json({ error: { message: "Not your booking", status: 403 } }, 403);
      }
      await setBookingPromo(sql, pnr, null);
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/payment-intent ------------------------------
  app.post("/:pnr/payment-intent", async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      const intent = await createPaymentIntent(sql, { pnr, sessionId });
      const booking = await loadBooking(sql, pnr);
      return c.json({ intent, booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/confirm --------------------------------------
  app.post("/:pnr/confirm", zValidator("json", confirmSchema), async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      await confirmPayment(sql, {
        pnr,
        sessionId,
        paymentId: c.req.valid("json").paymentId,
        card: c.req.valid("json").card,
      });
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  // --- POST /v1/bookings/:pnr/cancel ---------------------------------------
  app.post("/:pnr/cancel", async (c) => {
    const pnr = c.req.param("pnr").toUpperCase();
    const sessionId = getSessionId(c);
    if (!sessionId) {
      return c.json({ error: { message: "Missing x-booking-session", status: 400 } }, 400);
    }
    try {
      const sql = getSql();
      await cancelBooking(sql, { pnr, sessionId });
      const booking = await loadBooking(sql, pnr);
      return c.json({ booking });
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  return app;
}
