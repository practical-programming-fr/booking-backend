// POST /v1/_ops/incidents must forward the optional `kind` the frontend
// sends. Runs against the real route with the DB client mocked to an
// in-memory ops_incidents table.

import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const incidents: Row[] = [];
  let seq = 0;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" $ ").replace(/\s+/g, " ").trim().toLowerCase();

    if (text.startsWith("insert into public.ops_incidents")) {
      const [title, kind, events] = values as [string, string, unknown];
      const now = new Date();
      const row: Row = {
        id: `incident-${++seq}`,
        status: "open",
        kind,
        title,
        started_at: now,
        resolved_at: null,
        events,
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
    if (text.includes("from public.ops_incidents") && text.includes("where id =")) {
      const [id] = values as [string];
      return Promise.resolve(incidents.filter((r) => r.id === id));
    }
    throw new Error(`Unhandled query in fake sql: ${text}`);
  }) as unknown as { json: (value: unknown) => unknown };
  (sql as { json: (value: unknown) => unknown }).json = (value) => value;

  return { sql, incidents };
});

vi.mock("../src/db/client.js", () => ({ getSql: () => fake.sql }));

const stubEnv = () => {
  process.env.SUPABASE_DB_URL ??= "postgresql://stub:stub@localhost:5432/stub";
  delete process.env.OPS_SHARED_SECRET;
};

describe("POST /v1/_ops/incidents", () => {
  it("persists the provided kind", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const response = await buildApp().request("/v1/_ops/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Simulated traffic spike",
        kind: "spike",
        event: { kind: "detected", message: "traffic spike detected" },
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { incident: { kind: string } };
    expect(body.incident.kind).toBe("spike");
    expect(fake.incidents[0]?.kind).toBe("spike");
  });

  it("defaults kind to outage when omitted", async () => {
    stubEnv();
    const { buildApp } = await import("../src/app.js");
    const response = await buildApp().request("/v1/_ops/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { kind: "detected", message: "5xx spike on pricing" },
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { incident: { kind: string } };
    expect(body.incident.kind).toBe("outage");
  });
});
