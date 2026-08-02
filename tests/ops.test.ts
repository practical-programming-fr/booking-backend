// Ops domain tests. Like the other suites these avoid a live DB: they exercise
// the incident/flag helpers against a small in-memory fake of the postgres.js
// tagged-template client, matching the handful of queries these helpers issue.
// The goal is to lock in the incident `kind` behaviour (default 'outage',
// 'spike' round-trips) and the resetOps clears-both-flags contract.

import { describe, expect, it } from "vitest";
import {
  FARE_ADJUSTMENT_FLAG,
  createIncident,
  getFlag,
  getIncident,
  getOpenIncident,
  listIncidents,
  resetOps,
  setFlag,
} from "../src/domain/ops.js";

type Row = Record<string, unknown>;

const jsonMarker = Symbol("json");
type JsonWrap = { [jsonMarker]: true; value: unknown };
const isJson = (v: unknown): v is JsonWrap =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[jsonMarker] === true;

// Minimal stand-in for the postgres.js client covering only the queries the ops
// helpers under test run. Unhandled queries throw so the fake stays honest.
function createFakeSql() {
  const flags = new Map<
    string,
    { key: string; enabled: boolean; updated_at: Date; updated_by: string | null }
  >();
  const incidents: Row[] = [];
  let seq = 0;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" $ ").replace(/\s+/g, " ").trim().toLowerCase();

    if (text.startsWith("insert into public.ops_flags")) {
      const [key, enabled, actor] = values as [string, boolean, string | null];
      flags.set(key, { key, enabled, updated_at: new Date(), updated_by: actor ?? null });
      return Promise.resolve([] as Row[]);
    }

    if (text.startsWith("select enabled from public.ops_flags")) {
      const [key] = values as [string];
      const found = flags.get(key);
      return Promise.resolve(found ? [{ enabled: found.enabled }] : ([] as Row[]));
    }

    if (text.startsWith("insert into public.ops_incidents")) {
      const [title, kind, eventsWrap] = values as [string, string, unknown];
      const now = new Date();
      const row: Row = {
        id: `incident-${++seq}`,
        status: "open",
        kind,
        title,
        started_at: now,
        resolved_at: null,
        events: isJson(eventsWrap) ? eventsWrap.value : eventsWrap,
        summarizer_agent_id: null,
        fixer_agent_id: null,
        summary_posted: false,
        pr_url: null,
        pr_number: null,
        pr_posted: false,
        green_ticks: 0,
        updated_at: now,
      };
      incidents.push(row);
      return Promise.resolve([row]);
    }

    if (text.includes("from public.ops_incidents") && text.includes("where status = 'open'")) {
      const open = incidents
        .filter((r) => r.status === "open")
        .sort((a, b) => (b.started_at as Date).getTime() - (a.started_at as Date).getTime());
      return Promise.resolve(open.slice(0, 1));
    }

    if (text.includes("from public.ops_incidents") && text.includes("where id =")) {
      const [id] = values as [string];
      const found = incidents.find((r) => r.id === id);
      return Promise.resolve(found ? [found] : ([] as Row[]));
    }

    if (text.includes("from public.ops_incidents") && text.includes("order by started_at desc")) {
      const [limit] = values as [number];
      const sorted = [...incidents].sort(
        (a, b) => (b.started_at as Date).getTime() - (a.started_at as Date).getTime(),
      );
      return Promise.resolve(sorted.slice(0, limit));
    }

    if (text.startsWith("truncate table public.ops_errors")) {
      return Promise.resolve([] as Row[]);
    }

    if (text.startsWith("update public.ops_incidents") && text.includes("status = 'resolved'")) {
      const now = new Date();
      for (const r of incidents) {
        if (r.status === "open") {
          r.status = "resolved";
          r.resolved_at = now;
          r.updated_at = now;
        }
      }
      return Promise.resolve([] as Row[]);
    }

    throw new Error(`Unhandled query in fake sql: ${text}`);
  }) as unknown as import("postgres").Sql;

  (sql as unknown as { json: (value: unknown) => JsonWrap }).json = (value) => ({
    [jsonMarker]: true,
    value,
  });

  return { sql, flags, incidents };
}

const detected = (message: string) => ({
  at: new Date().toISOString(),
  kind: "detected",
  message,
});

describe("createIncident kind", () => {
  it("defaults the kind to 'outage'", async () => {
    const { sql } = createFakeSql();
    const incident = await createIncident(sql, { event: detected("5xx spike on pricing") });
    expect(incident.kind).toBe("outage");
  });

  it("round-trips an incident created with kind 'spike'", async () => {
    const { sql } = createFakeSql();
    const created = await createIncident(sql, {
      kind: "spike",
      title: "Simulated traffic spike",
      event: detected("traffic spike detected"),
    });
    expect(created.kind).toBe("spike");

    const fetched = await getIncident(sql, created.id);
    expect(fetched?.kind).toBe("spike");

    const open = await getOpenIncident(sql);
    expect(open?.kind).toBe("spike");

    const listed = await listIncidents(sql);
    expect(listed[0]?.kind).toBe("spike");
  });
});

describe("resetOps", () => {
  it("turns the outage flag off and closes open incidents of any kind", async () => {
    const { sql } = createFakeSql();
    await setFlag(sql, FARE_ADJUSTMENT_FLAG, true, "tester");
    const spike = await createIncident(sql, {
      kind: "spike",
      event: detected("traffic spike detected"),
    });

    expect(await getFlag(sql, FARE_ADJUSTMENT_FLAG)).toBe(true);

    await resetOps(sql);

    expect(await getFlag(sql, FARE_ADJUSTMENT_FLAG)).toBe(false);

    const after = await getIncident(sql, spike.id);
    expect(after?.status).toBe("resolved");
    expect(after?.resolvedAt).not.toBeNull();
  });
});
