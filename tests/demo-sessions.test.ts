// Scoped (per-session) outage tests.
//
// Like the other domain suites these avoid a live DB: they exercise the scoped
// outage data layer, the request-aware guard, and the in-memory TTL cache
// against a small in-memory fake of the postgres.js tagged-template client that
// covers only the queries these helpers issue. Unhandled queries throw so the
// fake stays honest.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FARE_ADJUSTMENT_FLAG,
  OPS_CACHE_TTL_MS,
  endDemoSession,
  invalidateOpsCache,
  isOutageActiveForRequest,
  listActiveDemoSessions,
  setFlag,
  startDemoSession,
} from "../src/domain/ops.js";

type DemoRow = {
  session_id: string;
  kind: string;
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

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
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
      const [sessionId, kind] = values as [string, string];
      // The fake resolves the interval to a fixed +ttl below via the ttl arg
      // encoded as the third value.
      const ttl = Number(values[2]);
      const now = new Date();
      const row: DemoRow = {
        session_id: sessionId,
        kind,
        created_at: sessions.get(sessionId)?.created_at ?? now,
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

    if (text.startsWith("select session_id from public.ops_demo_sessions")) {
      counters.sessionReads += 1;
      const now = Date.now();
      const active = [...sessions.values()].filter(
        (row) => row.expires_at.getTime() > now,
      );
      return Promise.resolve(active.map((row) => ({ session_id: row.session_id })));
    }

    throw new Error(`Unhandled query in fake sql: ${text}`);
  }) as unknown as import("postgres").Sql;

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
});

describe("isOutageActiveForRequest", () => {
  it("returns true for every request when the global flag is on, regardless of session", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, true);

    expect(await isOutageActiveForRequest(sql, undefined)).toBe(true);
    expect(await isOutageActiveForRequest(sql, "anyone")).toBe(true);
  });

  it("returns true only for the request carrying an active scoped session id", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await startDemoSession(sql, "scoped-A", 600);

    expect(await isOutageActiveForRequest(sql, "scoped-A")).toBe(true);
    // A different session, and no session at all, stay healthy.
    expect(await isOutageActiveForRequest(sql, "scoped-B")).toBe(false);
    expect(await isOutageActiveForRequest(sql, undefined)).toBe(false);
  });

  it("returns false when the scoped session has expired and the global flag is off", async () => {
    const { sql } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await startDemoSession(sql, "scoped-exp", 10);
    expect(await isOutageActiveForRequest(sql, "scoped-exp")).toBe(true);

    // Past the scoped TTL and past the cache TTL so the cache refreshes.
    vi.setSystemTime(new Date("2026-07-11T00:00:20Z"));
    expect(await isOutageActiveForRequest(sql, "scoped-exp")).toBe(false);
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
    await isOutageActiveForRequest(sql, "cache-A");
    const flagAfterFirst = counters.flagReads;
    const sessionAfterFirst = counters.sessionReads;

    for (let i = 0; i < 5; i++) {
      await isOutageActiveForRequest(sql, "cache-A");
    }

    expect(counters.flagReads).toBe(flagAfterFirst);
    expect(counters.sessionReads).toBe(sessionAfterFirst);
  });

  it("refreshes from the DB once the cache TTL has elapsed", async () => {
    const { sql, counters } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);

    await isOutageActiveForRequest(sql, undefined);
    const flagAfterFirst = counters.flagReads;

    // Within the TTL: no new read.
    vi.setSystemTime(new Date(Date.now() + OPS_CACHE_TTL_MS - 1000));
    await isOutageActiveForRequest(sql, undefined);
    expect(counters.flagReads).toBe(flagAfterFirst);

    // Past the TTL: one refresh.
    vi.setSystemTime(new Date(Date.now() + OPS_CACHE_TTL_MS + 1000));
    await isOutageActiveForRequest(sql, undefined);
    expect(counters.flagReads).toBe(flagAfterFirst + 1);
  });
});
