import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";

export const DEFAULT_DEMO_OUTAGE_TTL_MINUTES = 20;

export type DemoOutage = {
  demoSessionId: string;
  activationToken: string;
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

function hashActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createDemoOutage(
  sql: postgres.Sql,
  input: { ttlMinutes?: number; slackChannel?: string | null } = {},
): Promise<DemoOutage> {
  const ttlMinutes = input.ttlMinutes ?? DEFAULT_DEMO_OUTAGE_TTL_MINUTES;
  const activationToken = randomBytes(32).toString("base64url");
  const tokenHash = hashActivationToken(activationToken);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const rows = (await sql`
    insert into public.ops_demo_outages (
      activation_token_hash,
      slack_channel,
      status,
      expires_at
    )
    values (
      ${tokenHash},
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
    expiresAt: row.expires_at.toISOString(),
    ttlMinutes,
  };
}

export async function activateDemoOutage(
  sql: postgres.Sql,
  input: { activationToken: string; bookingSessionId: string },
): Promise<ActivatedDemoOutage> {
  const tokenHash = hashActivationToken(input.activationToken);

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
      status: "pending" | "active" | "cleared" | "expired";
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

    // One browser may hold only one pending/active bind. Re-pairing clears
    // that browser's previous outage without touching any other browser.
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
  demoSessionId: string,
): Promise<TriggeredDemoOutage> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      select id, booking_session_id, status, expires_at
      from public.ops_demo_outages
      where id = ${demoSessionId}
      limit 1
      for update
    `) as unknown as Array<{
      id: string;
      booking_session_id: string | null;
      status: "pending" | "active" | "cleared" | "expired";
      expires_at: Date;
    }>;

    const outage = rows[0];
    if (!outage) {
      throw new DemoOutageTriggerError(
        "outage_not_found",
        "No scoped demo outage matched that id.",
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
  demoSessionId: string,
): Promise<boolean> {
  const rows = (await sql`
    update public.ops_demo_outages
    set status = 'cleared', cleared_at = now()
    where id = ${demoSessionId}
      and status in ('pending', 'active')
    returning id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
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
