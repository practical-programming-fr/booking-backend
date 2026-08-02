// Ops incident console helpers.
//
// Thin data-access layer over the ops_flags / ops_errors / ops_incidents
// tables. Kept dependency-free (raw postgres.js) so the /v1/_ops routes and
// the pricing hot path can share it. Every read is defensive: if the tables
// do not exist yet (migration not applied) the flag read returns false and
// error logging is a no-op, so production is never taken down by the console
// itself.

import type postgres from "postgres";
import {
  activeDemoOutageIdForSession,
  clearAllDemoOutages,
  isDemoOutageActiveForSession,
  listActiveDemoOutageBindings,
} from "./demo-outage.js";

export const FARE_ADJUSTMENT_FLAG = "fare_adjustment_v2";

// TTL for the shared in-memory ops cache used on the pricing hot path. Within
// this window the request-aware outage guard answers from memory instead of
// hitting the DB, so the scoped check adds no per-request query in the common
// case. Kept short so a newly armed or ended scoped session (and any global
// flag flip) takes effect within a few seconds.
export const OPS_CACHE_TTL_MS = 7000;

export type OpsFlag = {
  key: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type OpsError = {
  id: number;
  occurredAt: string;
  method: string;
  path: string;
  status: number;
  message: string;
  stack: string | null;
  // Set only on a scoped (per-session) outage 500 so the NOC can attribute it
  // to the demo session that caused it. Null for global-outage and ordinary
  // 5xx, which keeps scoped failures distinguishable from global ones.
  demoSessionId: string | null;
};

export type IncidentEvent = {
  at: string;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
};

export type OpsIncident = {
  id: string;
  status: string;
  // 'outage' for a real, code-fix-worthy incident, 'spike' for a benign,
  // self-healing scenario. Defaults to 'outage' so existing incidents and the
  // outage flow are unchanged.
  kind: string;
  title: string;
  startedAt: string;
  resolvedAt: string | null;
  events: IncidentEvent[];
  summarizerAgentId: string | null;
  fixerAgentId: string | null;
  summaryPosted: boolean;
  prUrl: string | null;
  prNumber: number | null;
  prPosted: boolean;
  greenTicks: number;
  updatedAt: string;
};

export async function getFlag(sql: postgres.Sql, key: string): Promise<boolean> {
  try {
    const rows = (await sql`
      select enabled from public.ops_flags where key = ${key} limit 1
    `) as unknown as Array<{ enabled: boolean }>;
    return rows[0]?.enabled ?? false;
  } catch {
    // Table missing (pre-migration) or transient read failure: fail safe.
    return false;
  }
}

export async function fareAdjustmentEnabled(sql: postgres.Sql): Promise<boolean> {
  return getFlag(sql, FARE_ADJUSTMENT_FLAG);
}

// --- In-memory TTL cache + request-aware outage guard ---------------------
//
// Holds the global fare_adjustment_v2 flag state plus the active (triggered,
// unexpired) ops_demo_outages bindings, refreshed lazily on read once older
// than OPS_CACHE_TTL_MS, so the scoped check adds no per-request query in the
// cached case.

type OpsCacheState = {
  fetchedAt: number;
  globalOutage: boolean;
  activeOutageIds: Set<string>;
  boundBookingSessions: Map<string, string>;
};

let opsCache: OpsCacheState | null = null;

// Clear the cache so the next read reflects a just-changed flag or demo
// outage. Called at the mutation boundaries (setFlag, resetOps, and the
// routes that activate/trigger/clear runs) so ops actions take effect
// promptly rather than after the TTL.
export function invalidateOpsCache(): void {
  opsCache = null;
}

async function refreshOpsCache(sql: postgres.Sql): Promise<OpsCacheState> {
  const [globalOutage, bindings] = await Promise.all([
    getFlag(sql, FARE_ADJUSTMENT_FLAG),
    listActiveDemoOutageBindings(sql),
  ]);
  const activeOutageIds = new Set(bindings.map((binding) => binding.outageId));
  const boundBookingSessions = new Map(
    bindings.flatMap((binding) =>
      binding.bookingSessionId
        ? [[binding.bookingSessionId, binding.outageId] as const]
        : [],
    ),
  );
  opsCache = {
    fetchedAt: Date.now(),
    globalOutage,
    activeOutageIds,
    boundBookingSessions,
  };
  return opsCache;
}

async function getOpsCache(sql: postgres.Sql): Promise<OpsCacheState> {
  if (opsCache && Date.now() - opsCache.fetchedAt < OPS_CACHE_TTL_MS) {
    return opsCache;
  }
  return refreshOpsCache(sql);
}

// The outage guard for the pricing hot-path call sites. Returns true when the
// global outage flag is on (everyone 500s) OR when the request carries an
// active outage id in the demo header OR when its booking session is bound to
// an active run. Answers from the cache within the TTL; the final bound-session
// lookup hits ops_demo_outages directly so a fresh trigger takes effect before
// the cache expires.
export async function isOutageActiveForRequest(
  sql: postgres.Sql,
  identity: {
    demoSessionId?: string;
    bookingSessionId?: string;
  },
): Promise<boolean> {
  const cache = await getOpsCache(sql);
  if (cache.globalOutage) {
    return true;
  }
  if (identity.demoSessionId && cache.activeOutageIds.has(identity.demoSessionId)) {
    return true;
  }
  if (
    identity.bookingSessionId &&
    cache.boundBookingSessions.has(identity.bookingSessionId)
  ) {
    return true;
  }
  return identity.bookingSessionId
    ? isDemoOutageActiveForSession(sql, identity.bookingSessionId)
    : false;
}

// Resolve the scoped demo session id a 5xx should be attributed to, mirroring
// isOutageActiveForRequest so error attribution matches the outage decision.
// Answers from the cache when possible, but falls back to a direct
// ops_demo_outages lookup for a bound booking session so a freshly triggered
// scoped outage is still stamped when the cache is stale. Returns null under a
// global outage (everyone 500s regardless of session) to keep global-outage
// failures distinguishable from scoped ones.
export async function resolveDemoSessionIdForRequest(
  sql: postgres.Sql,
  identity: {
    demoSessionId?: string;
    bookingSessionId?: string;
  },
): Promise<string | null> {
  if (cachedGlobalOutageActive()) {
    return null;
  }
  if (opsCache) {
    if (identity.demoSessionId && opsCache.activeOutageIds.has(identity.demoSessionId)) {
      return identity.demoSessionId;
    }
    if (identity.bookingSessionId) {
      const bound = opsCache.boundBookingSessions.get(identity.bookingSessionId);
      if (bound) {
        return bound;
      }
    }
  }
  return identity.bookingSessionId
    ? activeDemoOutageIdForSession(sql, identity.bookingSessionId)
    : null;
}

// The last-known global outage flag state from the cache, without a DB hit.
// Used only by the error-logging path to decide whether a 500 should be
// attributed to a scoped session (global off) or left null (global on).
export function cachedGlobalOutageActive(): boolean {
  return opsCache?.globalOutage ?? false;
}

export async function setFlag(
  sql: postgres.Sql,
  key: string,
  enabled: boolean,
  actor?: string | null,
): Promise<void> {
  await sql`
    insert into public.ops_flags (key, enabled, updated_at, updated_by)
    values (${key}, ${enabled}, now(), ${actor ?? null})
    on conflict (key) do update
      set enabled = excluded.enabled,
          updated_at = now(),
          updated_by = excluded.updated_by
  `;
  invalidateOpsCache();
}

export async function listFlags(sql: postgres.Sql): Promise<OpsFlag[]> {
  const rows = (await sql`
    select key, enabled, updated_at, updated_by from public.ops_flags order by key
  `) as unknown as Array<{
    key: string;
    enabled: boolean;
    updated_at: Date;
    updated_by: string | null;
  }>;
  return rows.map((row) => ({
    key: row.key,
    enabled: row.enabled,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by ?? null,
  }));
}

export async function logOpsError(
  sql: postgres.Sql,
  entry: {
    method: string;
    path: string;
    status: number;
    message: string;
    stack?: string | null;
    // Stamped only for scoped (per-session) outage 500s; null otherwise.
    demoSessionId?: string | null;
  },
): Promise<void> {
  try {
    const stack = entry.stack ? entry.stack.slice(0, 4000) : null;
    const message = entry.message.slice(0, 1000);
    if (entry.demoSessionId) {
      // Scoped-outage 500: include the attribution column. Only reached once a
      // scoped session exists, which requires the migration (and thus the
      // column) to be present.
      await sql`
        insert into public.ops_errors (method, path, status, message, stack, demo_session_id)
        values (${entry.method}, ${entry.path}, ${entry.status}, ${message}, ${stack}, ${entry.demoSessionId})
      `;
    } else {
      // Global-outage and ordinary 5xx: unchanged insert, so error logging
      // keeps working even before the demo_session_id column exists.
      await sql`
        insert into public.ops_errors (method, path, status, message, stack)
        values (${entry.method}, ${entry.path}, ${entry.status}, ${message}, ${stack})
      `;
    }
  } catch {
    // Best effort: never let error logging mask the original error.
  }
}

export async function listRecentErrors(
  sql: postgres.Sql,
  limit = 50,
  demoSessionId?: string,
): Promise<OpsError[]> {
  const rows = (
    demoSessionId
      ? await sql`
          select id, occurred_at, method, path, status, message, stack, demo_session_id
          from public.ops_errors
          where demo_session_id = ${demoSessionId}
          order by occurred_at desc
          limit ${limit}
        `
      : await sql`
          select id, occurred_at, method, path, status, message, stack, demo_session_id
          from public.ops_errors
          order by occurred_at desc
          limit ${limit}
        `
  ) as unknown as Array<{
    id: number;
    occurred_at: Date;
    method: string;
    path: string;
    status: number;
    message: string;
    stack: string | null;
    demo_session_id: string | null;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    occurredAt: row.occurred_at.toISOString(),
    method: row.method,
    path: row.path,
    status: row.status,
    message: row.message,
    stack: row.stack,
    demoSessionId: row.demo_session_id ?? null,
  }));
}

export async function countRecentErrors(
  sql: postgres.Sql,
  sinceSeconds: number,
  demoSessionId?: string,
): Promise<number> {
  const rows = (
    demoSessionId
      ? await sql`
          select count(*)::int as n
          from public.ops_errors
          where status >= 500
            and demo_session_id = ${demoSessionId}
            and occurred_at > now() - (${sinceSeconds} || ' seconds')::interval
        `
      : await sql`
          select count(*)::int as n
          from public.ops_errors
          where status >= 500
            and occurred_at > now() - (${sinceSeconds} || ' seconds')::interval
        `
  ) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

function mapIncident(row: Record<string, unknown>): OpsIncident {
  return {
    id: row.id as string,
    status: row.status as string,
    // Fail safe to 'outage' if the kind column is missing (pre-migration).
    kind: (row.kind as string | null) ?? "outage",
    title: row.title as string,
    startedAt: (row.started_at as Date).toISOString(),
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : null,
    events: (row.events as IncidentEvent[]) ?? [],
    summarizerAgentId: (row.summarizer_agent_id as string | null) ?? null,
    fixerAgentId: (row.fixer_agent_id as string | null) ?? null,
    summaryPosted: Boolean(row.summary_posted),
    prUrl: (row.pr_url as string | null) ?? null,
    prNumber: row.pr_number != null ? Number(row.pr_number) : null,
    prPosted: Boolean(row.pr_posted),
    greenTicks: Number(row.green_ticks ?? 0),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function getOpenIncident(
  sql: postgres.Sql,
): Promise<OpsIncident | null> {
  const rows = (await sql`
    select * from public.ops_incidents
    where status = 'open'
    order by started_at desc
    limit 1
  `) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapIncident(rows[0]) : null;
}

export async function getIncident(
  sql: postgres.Sql,
  id: string,
): Promise<OpsIncident | null> {
  const rows = (await sql`
    select * from public.ops_incidents where id = ${id} limit 1
  `) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapIncident(rows[0]) : null;
}

export async function listIncidents(
  sql: postgres.Sql,
  limit = 10,
): Promise<OpsIncident[]> {
  const rows = (await sql`
    select * from public.ops_incidents
    order by started_at desc
    limit ${limit}
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapIncident);
}

export async function createIncident(
  sql: postgres.Sql,
  input: { title?: string; kind?: string; event: IncidentEvent },
): Promise<OpsIncident> {
  const rows = (await sql`
    insert into public.ops_incidents (title, kind, events)
    values (
      ${input.title ?? "Booking API incident"},
      ${input.kind ?? "outage"},
      ${sql.json([input.event] as unknown as postgres.JSONValue)}
    )
    returning *
  `) as unknown as Array<Record<string, unknown>>;
  return mapIncident(rows[0]!);
}

export async function appendIncidentEvent(
  sql: postgres.Sql,
  id: string,
  event: IncidentEvent,
): Promise<void> {
  await sql`
    update public.ops_incidents
    set events = events || ${sql.json([event] as unknown as postgres.JSONValue)}::jsonb,
        updated_at = now()
    where id = ${id}
  `;
}

export type IncidentPatch = {
  status?: string;
  resolvedAt?: string | null;
  summarizerAgentId?: string | null;
  fixerAgentId?: string | null;
  summaryPosted?: boolean;
  prUrl?: string | null;
  prNumber?: number | null;
  prPosted?: boolean;
  greenTicks?: number;
};

export async function updateIncident(
  sql: postgres.Sql,
  id: string,
  patch: IncidentPatch,
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.resolvedAt !== undefined) updates.resolved_at = patch.resolvedAt;
  if (patch.summarizerAgentId !== undefined)
    updates.summarizer_agent_id = patch.summarizerAgentId;
  if (patch.fixerAgentId !== undefined) updates.fixer_agent_id = patch.fixerAgentId;
  if (patch.summaryPosted !== undefined) updates.summary_posted = patch.summaryPosted;
  if (patch.prUrl !== undefined) updates.pr_url = patch.prUrl;
  if (patch.prNumber !== undefined) updates.pr_number = patch.prNumber;
  if (patch.prPosted !== undefined) updates.pr_posted = patch.prPosted;
  if (patch.greenTicks !== undefined) updates.green_ticks = patch.greenTicks;
  if (Object.keys(updates).length === 0) return;
  updates.updated_at = new Date();

  await sql`
    update public.ops_incidents
    set ${sql(updates)}
    where id = ${id}
  `;
}

// Reset for the demo: turn the fare_adjustment_v2 outage flag off, clear
// every live demo outage run, clear the error log, and close any open
// incidents of any kind. Called by the /v1/_ops/reset route (which the
// nightly reset workflow also hits) and the dashboard "disable flag" hatch.
export async function resetOps(sql: postgres.Sql): Promise<void> {
  await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
  await clearAllDemoOutages(sql);
  await sql`truncate table public.ops_errors restart identity`;
  await sql`
    update public.ops_incidents
    set status = 'resolved', resolved_at = now(), updated_at = now()
    where status = 'open'
  `;
  invalidateOpsCache();
}
