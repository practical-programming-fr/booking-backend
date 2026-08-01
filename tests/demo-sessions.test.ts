// Scoped (per-session) outage tests.
//
// Like the other domain suites these avoid a live DB: they exercise the scoped
// outage data layer, the request-aware guard, and the in-memory TTL cache
// against a small in-memory fake of the postgres.js tagged-template client that
// covers only the queries these helpers issue. Unhandled queries throw so the
// fake stays honest.

import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  FARE_ADJUSTMENT_FLAG,
  OPS_CACHE_TTL_MS,
  bindDemoSessionToBooking,
  endDemoSession,
  invalidateOpsCache,
  isOutageActiveForRequest,
  listActiveDemoSessions,
  listActiveDemoSessionsDetailed,
  setFlag,
  startDemoSession,
} from "../src/domain/ops.js";

type DemoRow = {
  session_id: string;
  kind: string;
  slack_channel: string | null;
  run_full_arc: boolean;
  activation_token_hash: string | null;
  bound_booking_session_id: string | null;
  activated_at: Date | null;
  created_at: Date;
  expires_at: Date;
};

// Counters let the cache tests assert that reads within the TTL do not touch
// the DB. Every table access the helpers make is tallied here.
type Counters = { flagReads: number; sessionReads: number };

// Minimal stand-in for the postgres.js client covering the queries the scoped
// outage helpers run: the flag read, and the demo-session insert/delete/select.
function createFakeSql() {
  const flags = new Map<string, boolean>();
  const sessions = new Map<string, DemoRow>();
  const counters: Counters = { flagReads: 0, sessionReads: 0 };

  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" $ ").replace(/\s+/g, " ").trim().toLowerCase();

    if (text.startsWith("insert into public.ops_flags")) {
      const [key, enabled] = values as [string, boolean];
      flags.set(key, enabled);
      return Promise.resolve([]);
    }

    if (text.startsWith("select enabled from public.ops_flags")) {
      counters.flagReads += 1;
      const [key] = values as [string];
      return Promise.resolve(flags.has(key) ? [{ enabled: flags.get(key) }] : []);
    }

    if (text.startsWith("insert into public.ops_demo_sessions")) {
      const [sessionId, kind, slackChannel, runFullArc, activationTokenHash] = values as [
        string,
        string,
        string | null,
        boolean,
        string | null,
      ];
      const ttl = Number(values[5]);
      const now = new Date();
      const existing = sessions.get(sessionId);
      const row: DemoRow = {
        session_id: sessionId,
        kind,
        slack_channel: slackChannel ?? null,
        run_full_arc: runFullArc,
        activation_token_hash:
          activationTokenHash ?? existing?.activation_token_hash ?? null,
        bound_booking_session_id: activationTokenHash
          ? null
          : existing?.bound_booking_session_id ?? null,
        activated_at: activationTokenHash ? null : existing?.activated_at ?? null,
        created_at: existing?.created_at ?? now,
        expires_at: new Date(now.getTime() + ttl * 1000),
      };
      sessions.set(sessionId, row);
      return Promise.resolve([row]);
    }

    if (text.startsWith("delete from public.ops_demo_sessions where session_id")) {
      const [sessionId] = values as [string];
      sessions.delete(sessionId);
      return Promise.resolve([]);
    }

    // Detailed listing: full row objects (checked before the ids-only branch
    // since both start with "select session_id").
    if (text.startsWith("select session_id, kind, slack_channel")) {
      counters.sessionReads += 1;
      const now = Date.now();
      const active = [...sessions.values()].filter(
        (row) => row.expires_at.getTime() > now,
      );
      return Promise.resolve(
        active.map((row) => ({
          session_id: row.session_id,
          kind: row.kind,
          slack_channel: row.slack_channel,
          run_full_arc: row.run_full_arc,
          bound_booking_session_id: row.bound_booking_session_id,
          activated_at: row.activated_at,
          created_at: row.created_at,
          expires_at: row.expires_at,
        })),
      );
    }

    if (
      text.startsWith("select session_id, bound_booking_session_id") &&
      text.includes("where expires_at > now()")
    ) {
      counters.sessionReads += 1;
      const now = Date.now();
      const active = [...sessions.values()].filter(
        (row) => row.expires_at.getTime() > now,
      );
      return Promise.resolve(
        active.map((row) => ({
          session_id: row.session_id,
          bound_booking_session_id: row.bound_booking_session_id,
        })),
      );
    }

    if (text.startsWith("select pg_advisory_xact_lock")) {
      return Promise.resolve([]);
    }

    if (
      text.startsWith(
        "select session_id, bound_booking_session_id, expires_at from public.ops_demo_sessions",
      )
    ) {
      const [tokenHash] = values as [string];
      const row = [...sessions.values()].find(
        (candidate) => candidate.activation_token_hash === tokenHash,
      );
      return Promise.resolve(row ? [row] : []);
    }

    if (
      text.startsWith(
        "update public.ops_demo_sessions set bound_booking_session_id = null",
      )
    ) {
      const [bookingSessionId, sessionId] = values as [string, string];
      for (const row of sessions.values()) {
        if (
          row.bound_booking_session_id === bookingSessionId &&
          row.session_id !== sessionId
        ) {
          row.bound_booking_session_id = null;
          row.activated_at = null;
        }
      }
      return Promise.resolve([]);
    }

    if (
      text.startsWith(
        "update public.ops_demo_sessions set bound_booking_session_id = $",
      )
    ) {
      const [bookingSessionId, sessionId] = values as [string, string];
      const row = sessions.get(sessionId);
      if (
        !row ||
        row.bound_booking_session_id ||
        row.expires_at.getTime() <= Date.now()
      ) {
        return Promise.resolve([]);
      }
      row.bound_booking_session_id = bookingSessionId;
      row.activated_at = new Date();
      return Promise.resolve([
        { session_id: row.session_id, expires_at: row.expires_at },
      ]);
    }

    throw new Error(`Unhandled query in fake sql: ${text}`);
  };
  const sql = Object.assign(query, {
    begin: async <T>(callback: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
      callback(sql),
  }) as unknown as postgres.Sql;

  return { sql, flags, sessions, counters };
}

afterEach(() => {
  // The cache is module-level; clear it between tests so state does not leak.
  invalidateOpsCache();
  vi.useRealTimers();
});

describe("startDemoSession / endDemoSession / listActiveDemoSessions", () => {
  it("round-trips a scoped session and lists it as active", async () => {
    const { sql } = createFakeSql();
    const session = await startDemoSession(sql, "sess-1", 60);
    expect(session.sessionId).toBe("sess-1");
    expect(session.kind).toBe("outage");

    const active = await listActiveDemoSessions(sql);
    expect(active).toContain("sess-1");
  });

  it("drops a session once it has expired", async () => {
    const { sql } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    await startDemoSession(sql, "sess-ttl", 10);
    expect(await listActiveDemoSessions(sql)).toContain("sess-ttl");

    // Advance past the 10 second TTL.
    vi.setSystemTime(new Date("2026-07-11T00:00:20Z"));
    expect(await listActiveDemoSessions(sql)).not.toContain("sess-ttl");
  });

  it("removes a session on endDemoSession", async () => {
    const { sql } = createFakeSql();
    await startDemoSession(sql, "sess-2", 60);
    expect(await listActiveDemoSessions(sql)).toContain("sess-2");

    await endDemoSession(sql, "sess-2");
    expect(await listActiveDemoSessions(sql)).not.toContain("sess-2");
  });

  it("defaults metadata when none is supplied (no channel, full arc)", async () => {
    const { sql } = createFakeSql();
    const session = await startDemoSession(sql, "sess-default", 60);
    expect(session.slackChannel).toBeNull();
    expect(session.runFullArc).toBe(true);
  });
});

describe("scoped session metadata (slackChannel / runFullArc)", () => {
  it("persists and returns slackChannel and runFullArc on start", async () => {
    const { sql } = createFakeSql();
    const session = await startDemoSession(sql, "sess-meta", 60, {
      slackChannel: "#incident-room",
      runFullArc: false,
    });
    expect(session.slackChannel).toBe("#incident-room");
    expect(session.runFullArc).toBe(false);
  });

  it("returns full session objects, including metadata, from the detailed listing", async () => {
    const { sql } = createFakeSql();
    await startDemoSession(sql, "sess-detailed", 600, {
      slackChannel: "#ops-demo",
      runFullArc: true,
    });

    const detailed = await listActiveDemoSessionsDetailed(sql);
    const found = detailed.find((s) => s.sessionId === "sess-detailed");
    expect(found).toBeDefined();
    expect(found?.slackChannel).toBe("#ops-demo");
    expect(found?.runFullArc).toBe(true);
    expect(found?.kind).toBe("outage");
    expect(found?.expiresAt).toBeDefined();
    expect(found?.createdAt).toBeDefined();
  });

  it("still returns a session with run_full_arc = false (flagged, not dropped)", async () => {
    const { sql } = createFakeSql();
    await startDemoSession(sql, "sess-quiet", 600, {
      slackChannel: "#quiet",
      runFullArc: false,
    });

    const detailed = await listActiveDemoSessionsDetailed(sql);
    const quiet = detailed.find((s) => s.sessionId === "sess-quiet");
    expect(quiet).toBeDefined();
    expect(quiet?.runFullArc).toBe(false);

    // The quiet session is still an active id for the hot path: a request
    // carrying it still 500s regardless of runFullArc.
    expect(await listActiveDemoSessions(sql)).toContain("sess-quiet");
  });
});

describe("bindDemoSessionToBooking", () => {
  const bookingSessionId = "11111111-1111-4111-8111-111111111111";
  const token = "test-activation-token-that-is-long-enough";
  const tokenHash =
    "062246bc1f3bbcab48be34a734f35a6bccb9debf42e7f2c920ac804a8181b762";

  it("binds an active demo to the browser booking session", async () => {
    const { sql } = createFakeSql();
    await startDemoSession(sql, "scoped-bind", 600, {
      activationTokenHash: tokenHash,
    });

    const result = await bindDemoSessionToBooking(sql, {
      activationToken: token,
      bookingSessionId,
    });

    expect(result).toMatchObject({
      demoSessionId: "scoped-bind",
      bookingSessionId,
    });
    expect(
      await isOutageActiveForRequest(sql, { bookingSessionId }),
    ).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, {
        bookingSessionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(false);
  });

  it("is idempotent in the same browser and rejects another browser", async () => {
    const { sql } = createFakeSql();
    await startDemoSession(sql, "scoped-once", 600, {
      activationTokenHash: tokenHash,
    });

    await bindDemoSessionToBooking(sql, { activationToken: token, bookingSessionId });
    await expect(
      bindDemoSessionToBooking(sql, { activationToken: token, bookingSessionId }),
    ).resolves.toMatchObject({ demoSessionId: "scoped-once" });
    await expect(
      bindDemoSessionToBooking(sql, {
        activationToken: token,
        bookingSessionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "activation_used",
    });
  });

  it("rejects an expired activation", async () => {
    const { sql } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    await startDemoSession(sql, "scoped-expired-activation", 10, {
      activationTokenHash: tokenHash,
    });
    vi.setSystemTime(new Date("2026-08-01T12:00:20Z"));

    await expect(
      bindDemoSessionToBooking(sql, { activationToken: token, bookingSessionId }),
    ).rejects.toMatchObject({
      status: 410,
      code: "activation_expired",
    });
  });
});

describe("isOutageActiveForRequest", () => {
  it("returns true for every request when the global flag is on, regardless of session", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, true);

    expect(await isOutageActiveForRequest(sql, {})).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "anyone" }),
    ).toBe(true);
  });

  it("returns true only for the request carrying an active scoped session id", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await startDemoSession(sql, "scoped-A", 600);

    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-A" }),
    ).toBe(true);
    // A different session, and no session at all, stay healthy.
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-B" }),
    ).toBe(false);
    expect(await isOutageActiveForRequest(sql, {})).toBe(false);
  });

  it("still 500s a matching session regardless of slackChannel / runFullArc", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    // A quiet, visual-outage-only session (runFullArc false) with a channel.
    await startDemoSession(sql, "scoped-quiet", 600, {
      slackChannel: "#quiet",
      runFullArc: false,
    });

    // The hot-path guard keys only off the active session id, so this request
    // still 500s exactly as before the metadata existed.
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-quiet" }),
    ).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-other" }),
    ).toBe(false);
  });

  it("returns false when the scoped session has expired and the global flag is off", async () => {
    const { sql } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await startDemoSession(sql, "scoped-exp", 10);
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-exp" }),
    ).toBe(true);

    // Past the scoped TTL and past the cache TTL so the cache refreshes.
    vi.setSystemTime(new Date("2026-07-11T00:00:20Z"));
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "scoped-exp" }),
    ).toBe(false);
  });
});

describe("in-memory TTL cache", () => {
  it("does not hit the DB again within the cache TTL", async () => {
    const { sql, counters } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await startDemoSession(sql, "cache-A", 600);

    // setFlag + startDemoSession both invalidate the cache, so the first guard
    // call after them refreshes (one flag read + one session read). Record the
    // baseline, then assert repeated calls within the TTL add nothing.
    await isOutageActiveForRequest(sql, { demoSessionId: "cache-A" });
    const flagAfterFirst = counters.flagReads;
    const sessionAfterFirst = counters.sessionReads;

    for (let i = 0; i < 5; i++) {
      await isOutageActiveForRequest(sql, { demoSessionId: "cache-A" });
    }

    expect(counters.flagReads).toBe(flagAfterFirst);
    expect(counters.sessionReads).toBe(sessionAfterFirst);
  });

  it("refreshes from the DB once the cache TTL has elapsed", async () => {
    const { sql, counters } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);

    await isOutageActiveForRequest(sql, {});
    const flagAfterFirst = counters.flagReads;

    // Within the TTL: no new read.
    vi.setSystemTime(new Date(Date.now() + OPS_CACHE_TTL_MS - 1000));
    await isOutageActiveForRequest(sql, {});
    expect(counters.flagReads).toBe(flagAfterFirst);

    // Past the TTL: one refresh.
    vi.setSystemTime(new Date(Date.now() + OPS_CACHE_TTL_MS + 1000));
    await isOutageActiveForRequest(sql, {});
    expect(counters.flagReads).toBe(flagAfterFirst + 1);
  });
});
