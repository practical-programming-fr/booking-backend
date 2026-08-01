// Ops incident console helpers.
//
// Thin data-access layer over the ops_flags / ops_errors / ops_incidents
// tables. Kept dependency-free (raw postgres.js) so the /v1/_ops routes and
// the pricing hot path can share it. Every read is defensive: if the tables
// do not exist yet (migration not applied) the flag read returns false and
// error logging is a no-op, so production is never taken down by the console
// itself.

import type postgres from "postgres";
import { loadEnv } from "../env.js";
import { hashDemoActivationToken } from "../lib/demo-activation.js";

export const FARE_ADJUSTMENT_FLAG = "fare_adjustment_v2";

// Benign, self-healing scenario flag. Unlike FARE_ADJUSTMENT_FLAG (which
// breaks the pricing path and produces real 5xx), this one is purely
// informational: it is never read on any request or pricing path, only by the
// ops layer, so enabling it keeps the booking site fully healthy. It exists to
// demo detection plus automatic self-recovery with no code fix and no PR.
export const TRAFFIC_SPIKE_FLAG = "traffic_spike_sim";

// Kind stored on a scoped (per-session) outage row. The scoped scenario mirrors
// the global fare_adjustment_v2 outage but is limited to a single session.
export const DEMO_SESSION_OUTAGE_KIND = "outage";

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

export type DemoSession = {
  sessionId: string;
  kind: string;
  // Which Slack channel THIS session's incident should post to. Null when the
  // session did not specify one (the frontend then falls back to its default).
  slackChannel: string | null;
  // Whether THIS session runs the full incident arc (detect plus agents plus
  // PR) vs a quiet, visual-outage-only session. Defaults to true so existing
  // rows and callers keep the current full-arc behaviour.
  runFullArc: boolean;
  boundBookingSessionId: string | null;
  activatedAt: string | null;
  createdAt: string;
  expiresAt: string;
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

// --- Scoped (per-session) outage sessions ---------------------------------
//
// A scoped outage breaks the booking site for a single session only. Rows live
// in public.ops_demo_sessions and lapse at expires_at. Every helper here is
// defensive: if the table is missing (pre-migration) or a read fails, the read
// paths fail safe (empty result / no-op), mirroring getFlag, so the pricing
// path is never taken down by the scoped-outage machinery itself.

function mapDemoSession(row: {
  session_id: string;
  kind: string;
  slack_channel?: string | null;
  run_full_arc?: boolean | null;
  bound_booking_session_id?: string | null;
  activated_at?: Date | null;
  created_at: Date;
  expires_at: Date;
}): DemoSession {
  return {
    sessionId: row.session_id,
    kind: row.kind,
    // Fail safe to null / true if the columns are missing (pre-migration).
    slackChannel: row.slack_channel ?? null,
    runFullArc: row.run_full_arc ?? true,
    boundBookingSessionId: row.bound_booking_session_id ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

// Optional per-session metadata the booking frontend Ops panel uses to route a
// scoped outage. Additive: omitting it preserves the previous behaviour (no
// Slack channel, full arc). Passed as an options object so the signature stays
// backward compatible with existing two/three-argument callers.
export type StartDemoSessionOptions = {
  // Which Slack channel THIS session's incident should post to.
  slackChannel?: string | null;
  // Whether THIS session runs the full incident arc. Defaults to true.
  runFullArc?: boolean;
  // SHA-256 of a one-time browser activation token. Only MCP supplies it.
  activationTokenHash?: string | null;
};

// Arm a scoped outage for `sessionId`, expiring `ttlSeconds` from now. Upserts
// so re-arming an existing session simply extends it (and refreshes its
// metadata). When ttlSeconds is omitted the env default
// (DEMO_SESSION_TTL_SECONDS) is used.
export async function startDemoSession(
  sql: postgres.Sql,
  sessionId: string,
  ttlSeconds?: number,
  options?: StartDemoSessionOptions,
): Promise<DemoSession> {
  const ttl =
    ttlSeconds && ttlSeconds > 0 ? ttlSeconds : loadEnv().DEMO_SESSION_TTL_SECONDS;
  const slackChannel = options?.slackChannel ?? null;
  const runFullArc = options?.runFullArc ?? true;
  const activationTokenHash = options?.activationTokenHash ?? null;
  try {
    const rows = (await sql`
      insert into public.ops_demo_sessions (
        session_id,
        kind,
        slack_channel,
        run_full_arc,
        activation_token_hash,
        expires_at
      )
      values (
        ${sessionId},
        ${DEMO_SESSION_OUTAGE_KIND},
        ${slackChannel},
        ${runFullArc},
        ${activationTokenHash},
        now() + (${ttl} || ' seconds')::interval
      )
      on conflict (session_id) do update
        set expires_at = excluded.expires_at,
            kind = excluded.kind,
            slack_channel = excluded.slack_channel,
            run_full_arc = excluded.run_full_arc,
            activation_token_hash = coalesce(
              excluded.activation_token_hash,
              public.ops_demo_sessions.activation_token_hash
            ),
            bound_booking_session_id = case
              when excluded.activation_token_hash is not null then null
              else public.ops_demo_sessions.bound_booking_session_id
            end,
            activated_at = case
              when excluded.activation_token_hash is not null then null
              else public.ops_demo_sessions.activated_at
            end
      returning
        session_id,
        kind,
        slack_channel,
        run_full_arc,
        bound_booking_session_id,
        activated_at,
        created_at,
        expires_at
    `) as unknown as Array<{
      session_id: string;
      kind: string;
      slack_channel: string | null;
      run_full_arc: boolean;
      bound_booking_session_id: string | null;
      activated_at: Date | null;
      created_at: Date;
      expires_at: Date;
    }>;
    invalidateOpsCache();
    if (rows[0]) {
      return mapDemoSession(rows[0]);
    }
  } catch {
    // Table missing (pre-migration) or transient failure: fall through to a
    // computed row so the caller still gets a coherent response.
  }
  const now = new Date();
  return {
    sessionId,
    kind: DEMO_SESSION_OUTAGE_KIND,
    slackChannel,
    runFullArc,
    boundBookingSessionId: null,
    activatedAt: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

export type ActivatedDemoSession = {
  demoSessionId: string;
  bookingSessionId: string;
  expiresAt: string;
};

export class DemoSessionActivationError extends Error {
  constructor(
    public readonly status: 404 | 409 | 410,
    message: string,
    public readonly code:
      | "activation_not_found"
      | "activation_expired"
      | "activation_used",
  ) {
    super(message);
    this.name = "DemoSessionActivationError";
  }
}

export async function bindDemoSessionToBooking(
  sql: postgres.Sql,
  input: { activationToken: string; bookingSessionId: string },
): Promise<ActivatedDemoSession> {
  const activationTokenHash = hashDemoActivationToken(input.activationToken);

  const activated = await sql.begin(async (tx) => {
    // Serialize activation attempts for one browser. This lets a new scoped
    // demo replace an older binding without racing the unique index.
    await tx`
      select pg_advisory_xact_lock(hashtext(${input.bookingSessionId}))
    `;

    const rows = (await tx`
      select
        session_id,
        bound_booking_session_id,
        expires_at
      from public.ops_demo_sessions
      where activation_token_hash = ${activationTokenHash}
      limit 1
      for update
    `) as unknown as Array<{
      session_id: string;
      bound_booking_session_id: string | null;
      expires_at: Date;
    }>;

    const session = rows[0];
    if (!session) {
      throw new DemoSessionActivationError(
        404,
        "This demo activation link is invalid.",
        "activation_not_found",
      );
    }
    if (session.expires_at.getTime() <= Date.now()) {
      throw new DemoSessionActivationError(
        410,
        "This demo activation link has expired.",
        "activation_expired",
      );
    }
    if (session.bound_booking_session_id === input.bookingSessionId) {
      return {
        demoSessionId: session.session_id,
        bookingSessionId: input.bookingSessionId,
        expiresAt: session.expires_at.toISOString(),
      };
    }
    if (session.bound_booking_session_id) {
      throw new DemoSessionActivationError(
        409,
        "This demo activation link was already used in another browser.",
        "activation_used",
      );
    }

    await tx`
      update public.ops_demo_sessions
      set bound_booking_session_id = null,
          activated_at = null
      where bound_booking_session_id = ${input.bookingSessionId}
        and session_id <> ${session.session_id}
    `;

    const updated = (await tx`
      update public.ops_demo_sessions
      set bound_booking_session_id = ${input.bookingSessionId},
          activated_at = now()
      where session_id = ${session.session_id}
        and bound_booking_session_id is null
        and expires_at > now()
      returning session_id, expires_at
    `) as unknown as Array<{ session_id: string; expires_at: Date }>;

    const row = updated[0];
    if (!row) {
      throw new DemoSessionActivationError(
        409,
        "This demo activation link has already been used.",
        "activation_used",
      );
    }

    return {
      demoSessionId: row.session_id,
      bookingSessionId: input.bookingSessionId,
      expiresAt: row.expires_at.toISOString(),
    };
  });

  invalidateOpsCache();
  return activated;
}

// End a scoped outage. No-op if the row (or table) is absent.
export async function endDemoSession(
  sql: postgres.Sql,
  sessionId: string,
): Promise<void> {
  try {
    await sql`
      delete from public.ops_demo_sessions where session_id = ${sessionId}
    `;
    invalidateOpsCache();
  } catch {
    // Best effort: never throw from the scoped-outage machinery.
  }
}

// The session ids with an active (unexpired) scoped outage. Fails safe to an
// empty array when the table is missing or a read fails. This is the hot-path
// helper feeding the in-memory cache and isOutageActiveForRequest, so it stays
// a lean, ids-only read (unchanged shape). Callers that need the per-session
// metadata use listActiveDemoSessionsDetailed instead.
type ActiveDemoSessionBinding = {
  sessionId: string;
  boundBookingSessionId: string | null;
};

async function listActiveDemoSessionBindings(
  sql: postgres.Sql,
): Promise<ActiveDemoSessionBinding[]> {
  try {
    const rows = (await sql`
      select session_id, bound_booking_session_id
      from public.ops_demo_sessions
      where expires_at > now()
    `) as unknown as Array<{
      session_id: string;
      bound_booking_session_id: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      boundBookingSessionId: row.bound_booking_session_id ?? null,
    }));
  } catch {
    return [];
  }
}

export async function listActiveDemoSessions(
  sql: postgres.Sql,
): Promise<string[]> {
  const bindings = await listActiveDemoSessionBindings(sql);
  return bindings.map((binding) => binding.sessionId);
}

// The full active (unexpired) scoped-outage sessions, including the per-session
// metadata (slack_channel, run_full_arc) the booking frontend Ops panel reads.
// Used by GET /demo-sessions, not on the pricing hot path. Fails safe to an
// empty array when the table is missing or a read fails. Sessions with
// run_full_arc = false are still returned (just flagged), so the frontend can
// list them and decide whether to fire the arc.
export async function listActiveDemoSessionsDetailed(
  sql: postgres.Sql,
): Promise<DemoSession[]> {
  try {
    const rows = (await sql`
      select
        session_id,
        kind,
        slack_channel,
        run_full_arc,
        bound_booking_session_id,
        activated_at,
        created_at,
        expires_at
      from public.ops_demo_sessions
      where expires_at > now()
      order by created_at desc
    `) as unknown as Array<{
      session_id: string;
      kind: string;
      slack_channel: string | null;
      run_full_arc: boolean;
      bound_booking_session_id: string | null;
      activated_at: Date | null;
      created_at: Date;
      expires_at: Date;
    }>;
    return rows.map(mapDemoSession);
  } catch {
    return [];
  }
}

// --- In-memory TTL cache + request-aware outage guard ---------------------
//
// Holds both the global fare_adjustment_v2 flag state and the set of active
// scoped session ids, refreshed lazily on read once older than OPS_CACHE_TTL_MS.
// This replaces the per-request raw DB read that fareAdjustmentEnabled did on
// the pricing hot path, and folds the scoped check into the same cached state
// so the scoped feature adds no extra per-request query in the cached case.

type OpsCacheState = {
  fetchedAt: number;
  globalOutage: boolean;
  activeSessions: Set<string>;
  boundBookingSessions: Map<string, string>;
};

let opsCache: OpsCacheState | null = null;

// Clear the cache so the next read reflects a just-changed flag or scoped
// session. Called by the mutation helpers (setFlag, start/endDemoSession,
// resetOps) so ops actions take effect promptly rather than after the TTL.
export function invalidateOpsCache(): void {
  opsCache = null;
}

async function refreshOpsCache(sql: postgres.Sql): Promise<OpsCacheState> {
  const [globalOutage, bindings] = await Promise.all([
    getFlag(sql, FARE_ADJUSTMENT_FLAG),
    listActiveDemoSessionBindings(sql),
  ]);
  const activeSessions = new Set(bindings.map((binding) => binding.sessionId));
  const boundBookingSessions = new Map(
    bindings.flatMap((binding) =>
      binding.boundBookingSessionId
        ? [[binding.boundBookingSessionId, binding.sessionId] as const]
        : [],
    ),
  );
  opsCache = {
    fetchedAt: Date.now(),
    globalOutage,
    activeSessions,
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

// The outage guard for the three pricing hot-path call sites. Returns true when
// the global outage flag is on (everyone 500s, unchanged) OR when the request
// carries a demo session id that is in the active scoped set (only that request
// 500s). Uses the cached state, so it does not hit the DB within the TTL.
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
  if (identity.demoSessionId && cache.activeSessions.has(identity.demoSessionId)) {
    return true;
  }
  if (
    identity.bookingSessionId &&
    cache.boundBookingSessions.has(identity.bookingSessionId)
  ) {
    return true;
  }
  return false;
}

export function cachedDemoSessionIdForRequest(identity: {
  demoSessionId?: string;
  bookingSessionId?: string;
}): string | null {
  if (!opsCache || opsCache.globalOutage) {
    return null;
  }
  if (identity.demoSessionId && opsCache.activeSessions.has(identity.demoSessionId)) {
    return identity.demoSessionId;
  }
  return identity.bookingSessionId
    ? opsCache.boundBookingSessions.get(identity.bookingSessionId) ?? null
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
): Promise<OpsError[]> {
  const rows = (await sql`
    select id, occurred_at, method, path, status, message, stack, demo_session_id
    from public.ops_errors
    order by occurred_at desc
    limit ${limit}
  `) as unknown as Array<{
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
): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n
    from public.ops_errors
    where status >= 500
      and occurred_at > now() - (${sinceSeconds} || ' seconds')::interval
  `) as unknown as Array<{ n: number }>;
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

// Reset for the demo: turn both scenario flags off (the fare_adjustment_v2
// outage and the benign traffic_spike_sim), clear the error log, close any open
// incidents of any kind, and wipe every scoped (per-session) outage session.
// Called by the /v1/_ops/reset route (which the nightly reset workflow also
// hits) and the dashboard "disable flag" hatch.
export async function resetOps(sql: postgres.Sql): Promise<void> {
  await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
  await setFlag(sql, TRAFFIC_SPIKE_FLAG, false);
  await sql`truncate table public.ops_errors restart identity`;
  await sql`
    update public.ops_incidents
    set status = 'resolved', resolved_at = now(), updated_at = now()
    where status = 'open'
  `;
  // Clear scoped outage sessions too, so the nightly reset returns the site to
  // a fully healthy state. Defensive: skip quietly if the table is absent.
  try {
    await sql`delete from public.ops_demo_sessions`;
  } catch {
    // Table missing (pre-migration): nothing to clear.
  }
  invalidateOpsCache();
}
