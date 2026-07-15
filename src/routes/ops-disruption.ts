// Agent-facing ops-disruption endpoints for the external FlyLo Ops Agent.
//
// Mounted at /v1/ops (distinct from /v1/_ops, the incident console). Every
// route is gated by requireOpsAgent: in production a valid `Authorization:
// Bearer <OPS_AGENT_TOKEN>` is required; in local dev without the token
// configured the routes are open so the stack runs without ceremony.
//
// Writes (cancel, rebook) go through the disruption domain, which reuses the
// booking primitives (seat status, fare counters, totals recompute,
// booking_events) so inventory and totals stay consistent.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getSql } from "../db/client.js";
import { requireOpsAgent } from "../lib/auth.js";
import {
  cancelFlight,
  listAlternatives,
  listFlightPassengers,
  rebookPassenger,
  resolveFlight,
  type FlightSelector,
} from "../domain/disruption.js";
import { DomainError } from "../domain/booking.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const cabinSchema = z.enum(["A", "P", "L"]);

const flightQuerySchema = z.object({
  departDate: isoDate.optional(),
  flightId: z.string().uuid().optional(),
});

const cancelSchema = z
  .object({
    departDate: isoDate.optional(),
    flightId: z.string().uuid().optional(),
    reason: z.string().max(500).optional(),
    actor: z.string().max(200).optional(),
  })
  .optional();

const alternativesQuerySchema = z.object({
  departDate: isoDate.optional(),
  flightId: z.string().uuid().optional(),
  windowDays: z.coerce.number().int().min(0).max(7).optional(),
});

const rebookSchema = z
  .object({
    pnr: z.string().min(6).max(6),
    passengerId: z.coerce.number().int().positive().optional(),
    fromSegmentId: z.coerce.number().int().positive(),
    toFlightId: z.string().uuid().optional(),
    toFlightNo: z.string().max(10).optional(),
    toDate: isoDate.optional(),
    cabin: cabinSchema.optional(),
    actor: z.string().max(200).optional(),
  })
  .refine((value) => Boolean(value.toFlightId || value.toFlightNo), {
    message: "Provide toFlightId or toFlightNo",
    path: ["toFlightId"],
  });

function handleDomainError(err: unknown):
  | { status: number; body: { error: { code: string; message: string; status: number } } }
  | null {
  if (err instanceof DomainError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, status: err.status } },
    };
  }
  return null;
}

export function opsDisruptionRoutes(): Hono {
  const app = new Hono();

  app.use("*", requireOpsAgent());

  // --- GET /v1/ops/flights/:flightNo/passengers ----------------------------
  app.get(
    "/flights/:flightNo/passengers",
    zValidator("query", flightQuerySchema),
    async (c) => {
      const sql = getSql();
      const selector: FlightSelector = {
        flightNo: c.req.param("flightNo"),
        departDate: c.req.valid("query").departDate,
        flightId: c.req.valid("query").flightId,
      };
      const flight = await resolveFlight(sql, selector);
      if (!flight) {
        return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
      }
      const passengers = await listFlightPassengers(sql, flight.id);
      return c.json({
        flight,
        counts: {
          bookings: new Set(passengers.map((passenger) => passenger.pnr)).size,
          passengers: passengers.length,
          withConnections: passengers.filter((passenger) => passenger.hasConnection).length,
        },
        passengers,
      });
    },
  );

  // --- POST /v1/ops/flights/:flightNo/cancel -------------------------------
  app.post(
    "/flights/:flightNo/cancel",
    zValidator("json", cancelSchema),
    async (c) => {
      const sql = getSql();
      const body = c.req.valid("json") ?? {};
      const selector: FlightSelector = {
        flightNo: c.req.param("flightNo"),
        departDate: body.departDate,
        flightId: body.flightId,
      };
      const flight = await resolveFlight(sql, selector);
      if (!flight) {
        return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
      }
      try {
        const result = await cancelFlight(sql, flight, {
          reason: body.reason,
          actor: body.actor,
        });
        return c.json(result);
      } catch (err) {
        const mapped = handleDomainError(err);
        if (mapped) return c.json(mapped.body, mapped.status as 400);
        throw err;
      }
    },
  );

  // --- GET /v1/ops/flights/:flightNo/alternatives --------------------------
  app.get(
    "/flights/:flightNo/alternatives",
    zValidator("query", alternativesQuerySchema),
    async (c) => {
      const sql = getSql();
      const query = c.req.valid("query");
      const selector: FlightSelector = {
        flightNo: c.req.param("flightNo"),
        departDate: query.departDate,
        flightId: query.flightId,
      };
      const flight = await resolveFlight(sql, selector);
      if (!flight) {
        return c.json({ error: { message: "Flight not found", status: 404 } }, 404);
      }
      const alternatives = await listAlternatives(sql, flight, {
        windowDays: query.windowDays,
      });
      return c.json({
        flight,
        windowDays: query.windowDays ?? 1,
        count: alternatives.length,
        alternatives,
      });
    },
  );

  // --- POST /v1/ops/rebook -------------------------------------------------
  app.post("/rebook", zValidator("json", rebookSchema), async (c) => {
    const sql = getSql();
    const body = c.req.valid("json");
    try {
      const result = await rebookPassenger(sql, {
        pnr: body.pnr.toUpperCase(),
        passengerId: body.passengerId,
        fromSegmentId: body.fromSegmentId,
        toFlightId: body.toFlightId,
        toFlightNo: body.toFlightNo,
        toDate: body.toDate,
        cabin: body.cabin,
        actor: body.actor,
      });
      return c.json(result, result.alreadyRebooked ? 200 : 201);
    } catch (err) {
      const mapped = handleDomainError(err);
      if (mapped) return c.json(mapped.body, mapped.status as 400);
      throw err;
    }
  });

  return app;
}
