import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getSql } from "../db/client.js";
import {
  armOpsDemoOutage,
  clearDemoOutageById,
  listLiveDemoOutages,
  OpsDemoOutageConflictError,
  type DemoOutageRun,
} from "../domain/demo-outage.js";
import { loadEnv } from "../env.js";
import {
  appendIncidentEvent,
  countRecentErrors,
  createIncident,
  getIncident,
  getOpenIncident,
  invalidateOpsCache,
  listFlags,
  listIncidents,
  listRecentErrors,
  resetOps,
  setFlag,
  updateIncident,
  type IncidentEvent,
} from "../domain/ops.js";

const eventSchema = z.object({
  at: z.string().optional(),
  kind: z.string().min(1).max(60),
  message: z.string().min(1).max(500),
  data: z.record(z.unknown()).optional(),
});

const flagSchema = z.object({
  key: z.string().min(1).max(80),
  enabled: z.boolean(),
  actor: z.string().max(200).nullable().optional(),
});

const startDemoSessionSchema = z.object({
  sessionId: z.string().uuid(),
  ttlSeconds: z.number().int().min(1).max(86400).optional(),
  slackChannel: z.string().max(200).optional(),
  runFullArc: z.boolean().optional(),
});

const createIncidentSchema = z.object({
  title: z.string().max(200).optional(),
  kind: z.string().min(1).max(60).optional(),
  event: eventSchema,
});

const patchIncidentSchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  resolvedAt: z.string().nullable().optional(),
  summarizerAgentId: z.string().nullable().optional(),
  fixerAgentId: z.string().nullable().optional(),
  summaryPosted: z.boolean().optional(),
  prUrl: z.string().nullable().optional(),
  prNumber: z.number().int().nullable().optional(),
  prPosted: z.boolean().optional(),
  greenTicks: z.number().int().optional(),
});

function withNow(event: z.infer<typeof eventSchema>): IncidentEvent {
  return {
    at: event.at ?? new Date().toISOString(),
    kind: event.kind,
    message: event.message,
    data: event.data,
  };
}

export function opsRoutes(): Hono {
  const app = new Hono();

  // Shared-secret gate. When OPS_SHARED_SECRET is set (production), every
  // route requires `Authorization: Bearer <secret>`. Unset in local dev so
  // the console works against localhost without ceremony.
  app.use("*", async (c, next) => {
    const expected = process.env.OPS_SHARED_SECRET;
    if (expected) {
      const provided = c.req.header("authorization");
      if (provided !== `Bearer ${expected}`) {
        return c.json({ error: { message: "Unauthorised", status: 401 } }, 401);
      }
    }
    return next();
  });

  // --- Flags ---------------------------------------------------------------
  app.get("/flags", async (c) => {
    return c.json({ flags: await listFlags(getSql()) });
  });

  app.post("/flags", zValidator("json", flagSchema), async (c) => {
    const { key, enabled, actor } = c.req.valid("json");
    await setFlag(getSql(), key, enabled, actor ?? null);
    return c.json({ ok: true, flags: await listFlags(getSql()) });
  });

  // --- Scoped demo outage projection ----------------------------------------
  // The ops console's /demo-sessions contract, projected from
  // ops_demo_outages. `sessionId` stays as an alias of the outage id so the
  // frontend can key off either.
  const projectRun = (run: DemoOutageRun) => ({
    id: run.id,
    sessionId: run.id,
    kind: "outage",
    status: run.status,
    slackChannel: run.slackChannel,
    runFullArc: run.runFullArc,
    boundBookingSessionId: run.boundBookingSessionId,
    activatedAt: run.activatedAt,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
  });

  app.get("/demo-sessions", async (c) => {
    const runs = await listLiveDemoOutages(getSql());
    return c.json({ sessions: runs.map(projectRun) });
  });

  app.post("/demo-sessions", zValidator("json", startDemoSessionSchema), async (c) => {
    const { sessionId, ttlSeconds, slackChannel, runFullArc } = c.req.valid("json");
    try {
      const run = await armOpsDemoOutage(getSql(), {
        id: sessionId,
        ttlSeconds: ttlSeconds ?? loadEnv().DEMO_SESSION_TTL_SECONDS,
        slackChannel: slackChannel ?? null,
        runFullArc: runFullArc ?? true,
      });
      invalidateOpsCache();
      return c.json({ session: projectRun(run) }, 201);
    } catch (error) {
      if (error instanceof OpsDemoOutageConflictError) {
        return c.json(
          { error: { message: error.message, status: error.status } },
          error.status,
        );
      }
      throw error;
    }
  });

  app.delete("/demo-sessions/:sessionId", async (c) => {
    await clearDemoOutageById(getSql(), c.req.param("sessionId"));
    invalidateOpsCache();
    return c.json({ ok: true });
  });

  // POST alias for clients that cannot send DELETE with a path param.
  app.post("/demo-sessions/:sessionId/end", async (c) => {
    await clearDemoOutageById(getSql(), c.req.param("sessionId"));
    invalidateOpsCache();
    return c.json({ ok: true });
  });

  // --- Error log -----------------------------------------------------------
  app.get("/errors", async (c) => {
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
      200,
    );
    return c.json({ errors: await listRecentErrors(getSql(), limit) });
  });

  app.get("/errors/count", async (c) => {
    const since = Math.min(
      Math.max(Number.parseInt(c.req.query("since") ?? "120", 10) || 120, 1),
      3600,
    );
    return c.json({ count: await countRecentErrors(getSql(), since), sinceSeconds: since });
  });

  // --- Incidents -----------------------------------------------------------
  app.get("/incidents", async (c) => {
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "10", 10) || 10, 1),
      50,
    );
    return c.json({ incidents: await listIncidents(getSql(), limit) });
  });

  app.get("/incidents/open", async (c) => {
    return c.json({ incident: await getOpenIncident(getSql()) });
  });

  app.post("/incidents", zValidator("json", createIncidentSchema), async (c) => {
    const { title, kind, event } = c.req.valid("json");
    const incident = await createIncident(getSql(), { title, kind, event: withNow(event) });
    return c.json({ incident }, 201);
  });

  app.get("/incidents/:id", async (c) => {
    const incident = await getIncident(getSql(), c.req.param("id"));
    if (!incident) {
      return c.json({ error: { message: "Incident not found", status: 404 } }, 404);
    }
    return c.json({ incident });
  });

  app.patch("/incidents/:id", zValidator("json", patchIncidentSchema), async (c) => {
    const id = c.req.param("id");
    const existing = await getIncident(getSql(), id);
    if (!existing) {
      return c.json({ error: { message: "Incident not found", status: 404 } }, 404);
    }
    await updateIncident(getSql(), id, c.req.valid("json"));
    return c.json({ incident: await getIncident(getSql(), id) });
  });

  app.post("/incidents/:id/events", zValidator("json", eventSchema), async (c) => {
    const id = c.req.param("id");
    const existing = await getIncident(getSql(), id);
    if (!existing) {
      return c.json({ error: { message: "Incident not found", status: 404 } }, 404);
    }
    await appendIncidentEvent(getSql(), id, withNow(c.req.valid("json")));
    return c.json({ incident: await getIncident(getSql(), id) });
  });

  // --- Reset ---------------------------------------------------------------
  // Turn the outage flag off, clear the error log, close open incidents.
  // Called by the dashboard "disable flag" hatch and the nightly reset
  // workflow (after it restores the seeded code from the checkpoint tag).
  app.post("/reset", async (c) => {
    await resetOps(getSql());
    return c.json({ ok: true });
  });

  return app;
}
