// Demo outage run tests: the pending -> bound -> active -> cleared/expired
// state machine, the run-handle control surface, and the hot-path ops cache.
// No live DB: a small in-memory fake of the postgres.js tagged-template client
// covers exactly the queries these helpers issue; unhandled queries throw.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  activateDemoOutage,
  armOpsDemoOutage,
  clearAllDemoOutages,
  clearDemoOutage,
  clearDemoOutageById,
  createDemoOutage,
  isDemoOutageActiveForSession,
  listActiveDemoOutageBindings,
  listLiveDemoOutages,
  triggerDemoOutage,
  type DemoOutageStatus,
} from "../src/domain/demo-outage.js";
import {
  FARE_ADJUSTMENT_FLAG,
  invalidateOpsCache,
  isOutageActiveForRequest,
  setFlag,
} from "../src/domain/ops.js";

type OutageRow = {
  id: string;
  activation_token_hash: string | null;
  run_handle_hash: string | null;
  booking_session_id: string | null;
  slack_channel: string | null;
  run_full_arc: boolean;
  status: DemoOutageStatus;
  expires_at: Date;
  created_at: Date;
  activated_at: Date | null;
  cleared_at: Date | null;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function createFakeSql() {
  const outages = new Map<string, OutageRow>();
  const flags = new Map<string, boolean>();
  const counters = { flagReads: 0, bindingReads: 0 };
  let seq = 0;

  const live = (row: OutageRow) =>
    row.status === "pending" || row.status === "active";

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

    if (text.startsWith("select pg_advisory_xact_lock")) {
      return Promise.resolve([]);
    }

    if (
      text.startsWith("insert into public.ops_demo_outages ( activation_token_hash")
    ) {
      const [tokenHash, handleHash, slackChannel, expiresAt] = values as [
        string,
        string,
        string | null,
        string,
      ];
      const row: OutageRow = {
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
        activation_token_hash: tokenHash,
        run_handle_hash: handleHash,
        booking_session_id: null,
        slack_channel: slackChannel,
        run_full_arc: true,
        status: "pending",
        expires_at: new Date(expiresAt),
        created_at: new Date(),
        activated_at: null,
        cleared_at: null,
      };
      outages.set(row.id, row);
      return Promise.resolve([{ id: row.id, expires_at: row.expires_at }]);
    }

    if (text.startsWith("insert into public.ops_demo_outages ( id")) {
      const [id, slackChannel, runFullArc, ttlSeconds] = values as [
        string,
        string | null,
        boolean,
        number,
      ];
      const existing = outages.get(id);
      const now = new Date();
      const row: OutageRow = {
        id,
        activation_token_hash: existing?.activation_token_hash ?? null,
        run_handle_hash: existing?.run_handle_hash ?? null,
        booking_session_id: existing?.booking_session_id ?? null,
        slack_channel: slackChannel,
        run_full_arc: runFullArc,
        status: "active",
        expires_at: new Date(now.getTime() + Number(ttlSeconds) * 1000),
        created_at: existing?.created_at ?? now,
        activated_at: existing?.activated_at ?? now,
        cleared_at: null,
      };
      outages.set(id, row);
      return Promise.resolve([row]);
    }

    if (
      text.startsWith("select id, booking_session_id, status, expires_at") &&
      text.includes("activation_token_hash =")
    ) {
      const [tokenHash] = values as [string];
      const row = [...outages.values()].find(
        (candidate) => candidate.activation_token_hash === tokenHash,
      );
      return Promise.resolve(row ? [row] : []);
    }

    if (
      text.startsWith("select id, booking_session_id, status, expires_at") &&
      text.includes("run_handle_hash =")
    ) {
      const [handleHash] = values as [string];
      const row = [...outages.values()].find(
        (candidate) => candidate.run_handle_hash === handleHash,
      );
      return Promise.resolve(row ? [row] : []);
    }

    if (text.includes("set status = 'expired'")) {
      const [id] = values as [string];
      const row = outages.get(id);
      if (row && live(row)) row.status = "expired";
      return Promise.resolve([]);
    }

    if (
      text.includes("set status = 'cleared'") &&
      text.includes("where booking_session_id =") &&
      text.includes("status in ('pending', 'active')")
    ) {
      const [bookingSessionId] = values as [string];
      for (const row of outages.values()) {
        if (row.booking_session_id === bookingSessionId && live(row)) {
          row.status = "cleared";
          row.cleared_at = new Date();
        }
      }
      return Promise.resolve([]);
    }

    if (
      text.includes("set status = 'cleared'") &&
      text.includes("where booking_session_id =") &&
      text.includes("status = 'active'")
    ) {
      const [bookingSessionId, exceptId] = values as [string, string];
      for (const row of outages.values()) {
        if (
          row.booking_session_id === bookingSessionId &&
          row.status === "active" &&
          row.id !== exceptId
        ) {
          row.status = "cleared";
          row.cleared_at = new Date();
        }
      }
      return Promise.resolve([]);
    }

    if (
      text.includes("set status = 'cleared'") &&
      text.includes("where run_handle_hash =")
    ) {
      const [handleHash] = values as [string];
      const row = [...outages.values()].find(
        (candidate) => candidate.run_handle_hash === handleHash && live(candidate),
      );
      if (!row) return Promise.resolve([]);
      row.status = "cleared";
      row.cleared_at = new Date();
      return Promise.resolve([{ id: row.id }]);
    }

    if (
      text.includes("set status = 'cleared'") &&
      text.includes("where id =")
    ) {
      const [id] = values as [string];
      const row = outages.get(id);
      if (!row || !live(row)) return Promise.resolve([]);
      row.status = "cleared";
      row.cleared_at = new Date();
      return Promise.resolve([{ id: row.id }]);
    }

    if (
      text.includes("set status = 'cleared'") &&
      text.includes("where status in ('pending', 'active')")
    ) {
      for (const row of outages.values()) {
        if (live(row)) {
          row.status = "cleared";
          row.cleared_at = new Date();
        }
      }
      return Promise.resolve([]);
    }

    if (text.includes("set booking_session_id =")) {
      const [bookingSessionId, id] = values as [string, string];
      const row = outages.get(id);
      if (!row || row.status !== "pending") return Promise.resolve([]);
      row.booking_session_id = bookingSessionId;
      row.activated_at = new Date();
      return Promise.resolve([{ id: row.id, expires_at: row.expires_at }]);
    }

    if (text.includes("set status = 'active'")) {
      const [id] = values as [string];
      const row = outages.get(id);
      if (!row || row.status !== "pending" || row.booking_session_id === null) {
        return Promise.resolve([]);
      }
      row.status = "active";
      return Promise.resolve([
        {
          id: row.id,
          booking_session_id: row.booking_session_id,
          expires_at: row.expires_at,
        },
      ]);
    }

    if (text.startsWith("select id, status, slack_channel")) {
      const now = Date.now();
      const rows = [...outages.values()]
        .filter((row) => live(row) && row.expires_at.getTime() > now)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return Promise.resolve(rows);
    }

    if (
      text.startsWith("select id, booking_session_id from public.ops_demo_outages")
    ) {
      counters.bindingReads += 1;
      const now = Date.now();
      const rows = [...outages.values()].filter(
        (row) => row.status === "active" && row.expires_at.getTime() > now,
      );
      return Promise.resolve(
        rows.map((row) => ({
          id: row.id,
          booking_session_id: row.booking_session_id,
        })),
      );
    }

    if (text.startsWith("select 1 from public.ops_demo_outages")) {
      const [bookingSessionId] = values as [string];
      const now = Date.now();
      const found = [...outages.values()].some(
        (row) =>
          row.booking_session_id === bookingSessionId &&
          row.status === "active" &&
          row.expires_at.getTime() > now,
      );
      return Promise.resolve(found ? [{ "?column?": 1 }] : []);
    }

    throw new Error(`Unhandled query in fake sql: ${text}`);
  };

  const sql = Object.assign(query, {
    begin: async <T>(callback: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
      callback(sql),
  }) as unknown as postgres.Sql;

  return { sql, outages, counters };
}

const BROWSER_A = "11111111-1111-4111-8111-111111111111";
const BROWSER_B = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  invalidateOpsCache();
  vi.useRealTimers();
});

describe("demo outage state machine", () => {
  it("prepare creates a pending run with distinct activation and run secrets", async () => {
    const { sql, outages } = createFakeSql();
    const outage = await createDemoOutage(sql, { slackChannel: "#incident" });

    expect(outage.runHandle).not.toBe(outage.activationToken);
    const row = outages.get(outage.demoSessionId);
    expect(row?.status).toBe("pending");
    expect(row?.activation_token_hash).toBe(sha256(outage.activationToken));
    expect(row?.run_handle_hash).toBe(sha256(outage.runHandle));
    expect(row?.slack_channel).toBe("#incident");
  });

  it("trigger before activation fails with outage_not_bound", async () => {
    const { sql } = createFakeSql();
    const outage = await createDemoOutage(sql);

    await expect(triggerDemoOutage(sql, outage.runHandle)).rejects.toMatchObject({
      code: "outage_not_bound",
    });
  });

  it("runs pending -> bound -> active -> cleared with the run handle", async () => {
    const { sql, outages } = createFakeSql();
    const outage = await createDemoOutage(sql);

    const activated = await activateDemoOutage(sql, {
      activationToken: outage.activationToken,
      bookingSessionId: BROWSER_A,
    });
    expect(activated.bookingSessionId).toBe(BROWSER_A);
    expect(outages.get(outage.demoSessionId)?.status).toBe("pending");

    const triggered = await triggerDemoOutage(sql, outage.runHandle);
    expect(triggered.bookingSessionId).toBe(BROWSER_A);
    expect(outages.get(outage.demoSessionId)?.status).toBe("active");
    expect(await isDemoOutageActiveForSession(sql, BROWSER_A)).toBe(true);

    const cleared = await clearDemoOutage(sql, outage.runHandle);
    expect(cleared).toEqual({ demoSessionId: outage.demoSessionId });
    expect(outages.get(outage.demoSessionId)?.status).toBe("cleared");
    expect(await isDemoOutageActiveForSession(sql, BROWSER_A)).toBe(false);
  });

  it("rejects an unknown run handle", async () => {
    const { sql } = createFakeSql();
    await createDemoOutage(sql);

    await expect(triggerDemoOutage(sql, "not-a-real-handle")).rejects.toMatchObject(
      { code: "outage_not_found" },
    );
    expect(await clearDemoOutage(sql, "not-a-real-handle")).toBeNull();
  });

  it("activation is single-use across browsers and idempotent within one", async () => {
    const { sql } = createFakeSql();
    const outage = await createDemoOutage(sql);

    await activateDemoOutage(sql, {
      activationToken: outage.activationToken,
      bookingSessionId: BROWSER_A,
    });
    await expect(
      activateDemoOutage(sql, {
        activationToken: outage.activationToken,
        bookingSessionId: BROWSER_A,
      }),
    ).resolves.toMatchObject({ demoSessionId: outage.demoSessionId });
    await expect(
      activateDemoOutage(sql, {
        activationToken: outage.activationToken,
        bookingSessionId: BROWSER_B,
      }),
    ).rejects.toMatchObject({ status: 409, code: "activation_used" });
  });

  it("activating a newer run supersedes the browser's previous live run", async () => {
    const { sql, outages } = createFakeSql();
    const first = await createDemoOutage(sql);
    await activateDemoOutage(sql, {
      activationToken: first.activationToken,
      bookingSessionId: BROWSER_A,
    });
    await triggerDemoOutage(sql, first.runHandle);

    const second = await createDemoOutage(sql);
    await activateDemoOutage(sql, {
      activationToken: second.activationToken,
      bookingSessionId: BROWSER_A,
    });

    expect(outages.get(first.demoSessionId)?.status).toBe("cleared");
    expect(outages.get(second.demoSessionId)?.status).toBe("pending");
    expect(outages.get(second.demoSessionId)?.booking_session_id).toBe(BROWSER_A);
  });

  it("rejects expired activation and trigger, marking the run expired", async () => {
    const { sql, outages } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    const outage = await createDemoOutage(sql, { ttlMinutes: 1 });
    await activateDemoOutage(sql, {
      activationToken: outage.activationToken,
      bookingSessionId: BROWSER_A,
    });

    vi.setSystemTime(new Date("2026-08-01T12:05:00Z"));
    await expect(triggerDemoOutage(sql, outage.runHandle)).rejects.toMatchObject({
      code: "outage_expired",
    });
    expect(outages.get(outage.demoSessionId)?.status).toBe("expired");
  });
});

describe("ops console projections", () => {
  it("armOpsDemoOutage creates an immediately active run by id", async () => {
    const { sql } = createFakeSql();
    const run = await armOpsDemoOutage(sql, {
      id: BROWSER_B,
      ttlSeconds: 600,
      slackChannel: "#ops-demo",
      runFullArc: false,
    });

    expect(run).toMatchObject({
      id: BROWSER_B,
      status: "active",
      slackChannel: "#ops-demo",
      runFullArc: false,
    });
    const bindings = await listActiveDemoOutageBindings(sql);
    expect(bindings.map((b) => b.outageId)).toContain(BROWSER_B);
  });

  it("lists live runs, hides cleared ones, and clears by id", async () => {
    const { sql } = createFakeSql();
    const prepared = await createDemoOutage(sql, { slackChannel: "#a" });
    await armOpsDemoOutage(sql, { id: BROWSER_B, ttlSeconds: 600 });

    const before = await listLiveDemoOutages(sql);
    expect(before.map((r) => r.id).sort()).toEqual(
      [prepared.demoSessionId, BROWSER_B].sort(),
    );

    expect(await clearDemoOutageById(sql, BROWSER_B)).toBe(true);
    expect(await clearDemoOutageById(sql, BROWSER_B)).toBe(false);

    const after = await listLiveDemoOutages(sql);
    expect(after.map((r) => r.id)).toEqual([prepared.demoSessionId]);
  });

  it("clearAllDemoOutages clears every live run", async () => {
    const { sql } = createFakeSql();
    await createDemoOutage(sql);
    await armOpsDemoOutage(sql, { id: BROWSER_B, ttlSeconds: 600 });

    await clearAllDemoOutages(sql);
    expect(await listLiveDemoOutages(sql)).toEqual([]);
  });
});

describe("isOutageActiveForRequest", () => {
  it("returns true for every request when the global flag is on", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, true);

    expect(await isOutageActiveForRequest(sql, {})).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: "anyone" }),
    ).toBe(true);
  });

  it("500s only the bound browser of an active run", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    const outage = await createDemoOutage(sql);
    await activateDemoOutage(sql, {
      activationToken: outage.activationToken,
      bookingSessionId: BROWSER_A,
    });
    invalidateOpsCache();
    expect(
      await isOutageActiveForRequest(sql, { bookingSessionId: BROWSER_A }),
    ).toBe(false);

    await triggerDemoOutage(sql, outage.runHandle);
    invalidateOpsCache();
    expect(
      await isOutageActiveForRequest(sql, { bookingSessionId: BROWSER_A }),
    ).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, { bookingSessionId: BROWSER_B }),
    ).toBe(false);
  });

  it("500s a request carrying an ops-armed run id in the demo header", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await armOpsDemoOutage(sql, { id: BROWSER_B, ttlSeconds: 600 });
    invalidateOpsCache();

    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_B }),
    ).toBe(true);
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_A }),
    ).toBe(false);
  });

  it("stops matching once the run expires", async () => {
    const { sql } = createFakeSql();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await armOpsDemoOutage(sql, { id: BROWSER_B, ttlSeconds: 10 });
    invalidateOpsCache();
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_B }),
    ).toBe(true);

    vi.setSystemTime(new Date("2026-08-01T12:00:20Z"));
    expect(
      await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_B }),
    ).toBe(false);
  });

  it("answers from the cache within the TTL without new binding reads", async () => {
    const { sql, counters } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, false);
    await armOpsDemoOutage(sql, { id: BROWSER_B, ttlSeconds: 600 });
    invalidateOpsCache();

    await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_B });
    const baseline = counters.bindingReads;
    for (let i = 0; i < 5; i++) {
      await isOutageActiveForRequest(sql, { demoSessionId: BROWSER_B });
    }
    expect(counters.bindingReads).toBe(baseline);
  });
});
