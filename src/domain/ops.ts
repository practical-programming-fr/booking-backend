// Ops incident console helpers.
//
// Thin data-access layer over the ops_flags / ops_errors / ops_incidents
// tables. Kept dependency-free (raw postgres.js) so the /v1/_ops routes and
// the pricing hot path can share it. Every read is defensive: if the tables
// do not exist yet (migration not applied) the flag read returns false and
// error logging is a no-op, so production is never taken down by the console
// itself.

import type postgres from "postgres";

export const FARE_ADJUSTMENT_FLAG = "fare_adjustment_v2";

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
  },
): Promise<void> {
  try {
    const stack = entry.stack ? entry.stack.slice(0, 4000) : null;
    await sql`
      insert into public.ops_errors (method, path, status, message, stack)
      values (${entry.method}, ${entry.path}, ${entry.status}, ${entry.message.slice(0, 1000)}, ${stack})
    `;
  } catch {
    // Best effort: never let error logging mask the original error.
  }
}

export async function listRecentErrors(
  sql: postgres.Sql,
  limit = 50,
): Promise<OpsError[]> {
  const rows = (await sql`
    select id, occurred_at, method, path, status, message, stack
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
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    occurredAt: row.occurred_at.toISOString(),
    method: row.method,
    path: row.path,
    status: row.status,
    message: row.message,
    stack: row.stack,
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
  input: { title?: string; event: IncidentEvent },
): Promise<OpsIncident> {
  const rows = (await sql`
    insert into public.ops_incidents (title, events)
    values (
      ${input.title ?? "Booking API incident"},
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

// Reset for the demo: turn the outage flag off, clear the error log, and
// close any open incidents. Called by the /v1/_ops/reset route (which the
// nightly reset workflow also hits) and the dashboard "disable flag" hatch.
export async function resetOps(sql: postgres.Sql): Promise<void> {
  await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
  await sql`truncate table public.ops_errors restart identity`;
  await sql`
    update public.ops_incidents
    set status = 'resolved', resolved_at = now(), updated_at = now()
    where status = 'open'
  `;
}
