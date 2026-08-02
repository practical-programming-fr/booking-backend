// Demo outage runs.
//
// One row in public.ops_demo_outages is a state machine:
//
//   pending (unbound) --activate--> pending (bound) --trigger--> active
//   any live state --clear--> cleared
//   any live state past expires_at --> expired
//
// Two secrets control a run, both stored as SHA-256 hashes:
// - activation token: single-use, opened once in the presenter browser to
//   bind the run to that browser's booking session.
// - run handle: returned to the operator once at prepare time; trigger and
//   clear look the run up by its hash, so the bare row UUID never grants
//   control. The UUID (demoSessionId) is exposed only for attribution
//   (ops_errors stamping, ops console listing).

import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";

export const DEFAULT_DEMO_OUTAGE_TTL_MINUTES = 20;

export type DemoOutageStatus = "pending" | "active" | "cleared" | "expired";

export type DemoOutage = {
  demoSessionId: string;
  activationToken: string;
  runHandle: string;
  expiresAt: string;
  ttlMinutes: number;
};

export type ActivatedDemoOutage = {
  demoSessionId: string;
  bookingSessionId: string;
  expiresAt: string;
};

export type TriggeredDemoOutage = {
  demoSessionId: string;
  bookingSessionId: string;
  expiresAt: string;
};

export type ClearedDemoOutage = {
  demoSessionId: string;
};

// Projection of a live (pending or active, unexpired) run for the ops
// console. Shaped to match what the booking-frontend /demo-sessions client
// already reads; the run handle hash is never included.
export type DemoOutageRun = {
  id: string;
  status: DemoOutageStatus;
  slackChannel: string | null;
  runFullArc: boolean;
  boundBookingSessionId: string | null;
  activatedAt: string | null;
  createdAt: string;
  expiresAt: string;
};

export type DemoOutageBinding = {
  outageId: string;
  bookingSessionId: string | null;
};

export class DemoOutageActivationError extends Error {
  constructor(
    public readonly status: 404 | 409 | 410,
    message: string,
    public readonly code:
      | "activation_not_found"
      | "activation_expired"
      | "activation_used",
  ) {
    super(message);
    this.name = "DemoOutageActivationError";
  }
}

export class DemoOutageTriggerError extends Error {
  constructor(
    public readonly code:
      | "outage_not_found"
      | "outage_not_bound"
      | "outage_expired"
      | "outage_not_pending",
    message: string,
  ) {
    super(message);
    this.name = "DemoOutageTriggerError";
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createDemoOutage(
  sql: postgres.Sql,
  input: { ttlMinutes?: number; slackChannel?: string | null } = {},
): Promise<DemoOutage> {
  const ttlMinutes = input.ttlMinutes ?? DEFAULT_DEMO_OUTAGE_TTL_MINUTES;
  const activationToken = randomBytes(32).toString("base64url");
  const runHandle = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const rows = (await sql`
    insert into public.ops_demo_outages (
      activation_token_hash,
      run_handle_hash,
      slack_channel,
      status,
      expires_at
    )
    values (
      ${sha256Hex(activationToken)},
      ${sha256Hex(runHandle)},
      ${input.slackChannel ?? null},
      'pending',
      ${expiresAt.toISOString()}
    )
    returning id, expires_at
  `) as unknown as Array<{ id: string; expires_at: Date }>;

  const row = rows[0];
  if (!row) {
    throw new Error("Failed to create scoped demo outage");
  }

  return {
    demoSessionId: row.id,
    activationToken,
    runHandle,
    expiresAt: row.expires_at.toISOString(),
    ttlMinutes,
  };
}

export async function activateDemoOutage(
  sql: postgres.Sql,
  input: { activationToken: string; bookingSessionId: string },
): Promise<ActivatedDemoOutage> {
  const tokenHash = sha256Hex(input.activationToken);

  return sql.begin(async (tx) => {
    // Serialize concurrent binds for the same browser session so two different
    // activation tokens cannot both attach the same booking_session_id and trip
    // the pending/active uniqueness index as an unhandled error.
    await tx`select pg_advisory_xact_lock(hashtext(${input.bookingSessionId}))`;

    const rows = (await tx`
      select id, booking_session_id, status, expires_at
      from public.ops_demo_outages
      where activation_token_hash = ${tokenHash}
      limit 1
      for update
    `) as unknown as Array<{
      id: string;
      booking_session_id: string | null;
      status: DemoOutageStatus;
      expires_at: Date;
    }>;

    const outage = rows[0];
    if (!outage) {
      throw new DemoOutageActivationError(
        404,
        "This demo activation link is invalid.",
        "activation_not_found",
      );
    }

    if (outage.expires_at.getTime() <= Date.now()) {
      await tx`
        update public.ops_demo_outages
        set status = 'expired'
        where id = ${outage.id}
          and status in ('pending', 'active')
      `;
      throw new DemoOutageActivationError(
        410,
        "This demo activation link has expired.",
        "activation_expired",
      );
    }

    if (outage.status === "active") {
      if (outage.booking_session_id === input.bookingSessionId) {
        return {
          demoSessionId: outage.id,
          bookingSessionId: input.bookingSessionId,
          expiresAt: outage.expires_at.toISOString(),
        };
      }
      throw new DemoOutageActivationError(
        409,
        "This demo activation link was already used in another browser.",
        "activation_used",
      );
    }

    if (outage.status !== "pending") {
      throw new DemoOutageActivationError(
        409,
        "This demo activation link has already been used.",
        "activation_used",
      );
    }

    if (outage.booking_session_id === input.bookingSessionId) {
      return {
        demoSessionId: outage.id,
        bookingSessionId: input.bookingSessionId,
        expiresAt: outage.expires_at.toISOString(),
      };
    }

    if (outage.booking_session_id !== null) {
      throw new DemoOutageActivationError(
        409,
        "This demo activation link was already used in another browser.",
        "activation_used",
      );
    }

    // One browser may hold only one pending/active bind. Activating a new run
    // supersedes that browser's previous run without touching other browsers.
    await tx`
      update public.ops_demo_outages
      set status = 'cleared', cleared_at = now()
      where booking_session_id = ${input.bookingSessionId}
        and status in ('pending', 'active')
    `;

    const bound = (await tx`
      update public.ops_demo_outages
      set booking_session_id = ${input.bookingSessionId},
          activated_at = now()
      where id = ${outage.id}
        and status = 'pending'
      returning id, expires_at
    `) as unknown as Array<{ id: string; expires_at: Date }>;

    const row = bound[0];
    if (!row) {
      throw new Error("Failed to bind scoped demo outage");
    }

    return {
      demoSessionId: row.id,
      bookingSessionId: input.bookingSessionId,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

export async function triggerDemoOutage(
  sql: postgres.Sql,
  runHandle: string,
): Promise<TriggeredDemoOutage> {
  const handleHash = sha256Hex(runHandle);

  return sql.begin(async (tx) => {
    const rows = (await tx`
      select id, booking_session_id, status, expires_at
      from public.ops_demo_outages
      where run_handle_hash = ${handleHash}
      limit 1
      for update
    `) as unknown as Array<{
      id: string;
      booking_session_id: string | null;
      status: DemoOutageStatus;
      expires_at: Date;
    }>;

    const outage = rows[0];
    if (!outage) {
      throw new DemoOutageTriggerError(
        "outage_not_found",
        "No scoped demo outage matched that run handle.",
      );
    }

    if (outage.expires_at.getTime() <= Date.now()) {
      await tx`
        update public.ops_demo_outages
        set status = 'expired'
        where id = ${outage.id}
          and status in ('pending', 'active')
      `;
      throw new DemoOutageTriggerError(
        "outage_expired",
        "This scoped demo outage has expired.",
      );
    }

    if (outage.status !== "pending") {
      throw new DemoOutageTriggerError(
        "outage_not_pending",
        "This scoped demo outage is not waiting to be triggered.",
      );
    }

    if (outage.booking_session_id === null) {
      throw new DemoOutageTriggerError(
        "outage_not_bound",
        "Open the activation URL in the presenter browser before triggering the outage.",
      );
    }

    await tx`
      update public.ops_demo_outages
      set status = 'cleared', cleared_at = now()
      where booking_session_id = ${outage.booking_session_id}
        and status = 'active'
        and id <> ${outage.id}
    `;

    const triggered = (await tx`
      update public.ops_demo_outages
      set status = 'active'
      where id = ${outage.id}
        and status = 'pending'
        and booking_session_id is not null
      returning id, booking_session_id, expires_at
    `) as unknown as Array<{
      id: string;
      booking_session_id: string;
      expires_at: Date;
    }>;

    const row = triggered[0];
    if (!row) {
      throw new Error("Failed to trigger scoped demo outage");
    }

    return {
      demoSessionId: row.id,
      bookingSessionId: row.booking_session_id,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

export async function clearDemoOutage(
  sql: postgres.Sql,
  runHandle: string,
): Promise<ClearedDemoOutage | null> {
  const rows = (await sql`
    update public.ops_demo_outages
    set status = 'cleared', cleared_at = now()
    where run_handle_hash = ${sha256Hex(runHandle)}
      and status in ('pending', 'active')
    returning id
  `) as unknown as Array<{ id: string }>;
  const row = rows[0];
  return row ? { demoSessionId: row.id } : null;
}

// Clear by row id. Only for the OPS_SHARED_SECRET-gated console routes; the
// MCP surface requires the run handle instead.
export async function clearDemoOutageById(
  sql: postgres.Sql,
  outageId: string,
): Promise<boolean> {
  const rows = (await sql`
    update public.ops_demo_outages
    set status = 'cleared', cleared_at = now()
    where id = ${outageId}
      and status in ('pending', 'active')
    returning id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

// Arm an immediately-active run keyed by a caller-chosen id, with no
// activation or run handle. This backs the ops console's legacy
// POST /demo-sessions flow, where the browser carries the id in the
// x-demo-session header instead of binding a booking session.
export async function armOpsDemoOutage(
  sql: postgres.Sql,
  input: {
    id: string;
    ttlSeconds: number;
    slackChannel?: string | null;
    runFullArc?: boolean;
  },
): Promise<DemoOutageRun> {
  const rows = (await sql`
    insert into public.ops_demo_outages (
      id,
      slack_channel,
      run_full_arc,
      status,
      activated_at,
      expires_at
    )
    values (
      ${input.id},
      ${input.slackChannel ?? null},
      ${input.runFullArc ?? true},
      'active',
      now(),
      now() + (${input.ttlSeconds} || ' seconds')::interval
    )
    on conflict (id) do update
      set slack_channel = excluded.slack_channel,
          run_full_arc = excluded.run_full_arc,
          status = 'active',
          cleared_at = null,
          expires_at = excluded.expires_at
    returning id, status, slack_channel, run_full_arc, booking_session_id,
      activated_at, created_at, expires_at
  `) as unknown as Array<RunRow>;

  const row = rows[0];
  if (!row) {
    throw new Error("Failed to arm ops demo outage");
  }
  return mapRun(row);
}

type RunRow = {
  id: string;
  status: DemoOutageStatus;
  slack_channel: string | null;
  run_full_arc: boolean;
  booking_session_id: string | null;
  activated_at: Date | null;
  created_at: Date;
  expires_at: Date;
};

function mapRun(row: RunRow): DemoOutageRun {
  return {
    id: row.id,
    status: row.status,
    slackChannel: row.slack_channel ?? null,
    runFullArc: row.run_full_arc ?? true,
    boundBookingSessionId: row.booking_session_id ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

// Live (pending or active, unexpired) runs for the ops console listing. Not
// on the pricing hot path. Fails safe to empty when the read fails.
export async function listLiveDemoOutages(
  sql: postgres.Sql,
): Promise<DemoOutageRun[]> {
  try {
    const rows = (await sql`
      select id, status, slack_channel, run_full_arc, booking_session_id,
        activated_at, created_at, expires_at
      from public.ops_demo_outages
      where status in ('pending', 'active')
        and expires_at > now()
      order by created_at desc
    `) as unknown as Array<RunRow>;
    return rows.map(mapRun);
  } catch {
    return [];
  }
}

// Active (triggered, unexpired) runs for the hot-path ops cache. Fails safe
// to empty so the pricing path is never taken down by the demo machinery.
export async function listActiveDemoOutageBindings(
  sql: postgres.Sql,
): Promise<DemoOutageBinding[]> {
  try {
    const rows = (await sql`
      select id, booking_session_id
      from public.ops_demo_outages
      where status = 'active'
        and expires_at > now()
    `) as unknown as Array<{ id: string; booking_session_id: string | null }>;
    return rows.map((row) => ({
      outageId: row.id,
      bookingSessionId: row.booking_session_id ?? null,
    }));
  } catch {
    return [];
  }
}

export async function isDemoOutageActiveForSession(
  sql: postgres.Sql,
  bookingSessionId: string,
): Promise<boolean> {
  try {
    const rows = (await sql`
      select 1
      from public.ops_demo_outages
      where booking_session_id = ${bookingSessionId}
        and status = 'active'
        and expires_at > now()
      limit 1
    `) as unknown as Array<{ "?column?": number }>;
    return rows.length > 0;
  } catch {
    // A missing migration or transient lookup must never affect real bookings.
    return false;
  }
}

export async function clearAllDemoOutages(sql: postgres.Sql): Promise<void> {
  try {
    await sql`
      update public.ops_demo_outages
      set status = 'cleared', cleared_at = now()
      where status in ('pending', 'active')
    `;
  } catch {
    // Keep reset compatible while the migration rolls out.
  }
}
