# Demo contract stabilization, unit 1: decisions

Scope: the branch `stabilize/demo-contract`, backend only.

## Data shape

A demo outage run is one row in `public.ops_demo_outages`, a state machine
encoded in `src/domain/demo-outage.ts`:

```
pending (unbound) --activate--> pending (bound) --trigger--> active
any live state --clear--> cleared
any live state past expires_at --> expired
```

Two secrets control a run, both stored as SHA-256 hashes and returned in
plaintext exactly once by `prepare_demo_outage`:

- `activation_token_hash`: single-use browser bind (opened via the activation
  URL).
- `run_handle_hash` (new column): operator control. `trigger_demo_outage` and
  `clear_demo_outage` require the handle; the row UUID (`demoSessionId`) is
  attribution-only and grants no control. A separate handle was chosen over
  reusing the UUID because the UUID leaks into ops listings and `ops_errors`
  rows, where it must stay safe to display.

## Legacy table

`public.ops_demo_sessions` is gone. Runtime paths (pricing guard, ops cache,
`/v1/demo/activate`, MCP tools) read only `ops_demo_outages`. The
booking-frontend still calls `/v1/_ops/demo-sessions` (list from the
orchestrator tick and status route, create from the ops panel trigger route,
delete from resolve), so those routes stay but are a thin projection over
`ops_demo_outages`:

- `GET` lists live (pending or active, unexpired) runs; `sessionId` aliases
  the outage id.
- `POST` upserts an immediately-active run keyed by the caller-chosen UUID
  (`run_full_arc`, new column, carries the orchestrator metadata). These rows
  have no activation token or run handle; they are managed by id behind
  `OPS_SHARED_SECRET`, and the browser is broken via the `x-demo-session`
  header carrying the id, as before.
- `DELETE /:id` (and the POST `/end` alias) clears by id.

Migrations: `20260801160000_ops_demo_outages_run_handle.sql` adds
`run_handle_hash` and `run_full_arc` and makes `activation_token_hash`
nullable; `20260801161000_drop_ops_demo_sessions.sql` drops the legacy table.
No backfill: legacy rows carried nothing the new path needs.

## Supersede over reject

Activating a new run for a browser clears that browser's earlier live runs;
triggering a run clears any other active run on the same booking session.
Re-preparing therefore never wedges a presenter.

## Other decisions

- `FLYLO_MCP_TOKEN` (optional) gates `/mcp` with a bearer check before the
  transport runs; unset keeps local dev open. No global flag or reset tools
  are exposed over MCP.
- `traffic_spike_sim` is removed from this repo; `fare_adjustment_v2` remains
  for the operator global flow and `resetOps`.
- `POST /v1/_ops/incidents` accepts and persists optional `kind` (the
  frontend already sends it).
- `request_marketing_change` validates `discountPercent` (0 < n <= 100) and
  `startsAt`/`endsAt` (ISO dates, ends >= starts) before touching Jira.
- `scripts/verify-mcp-contract.mjs` re-checks the tool inventory, runHandle
  requirement, and the 401 gate against the real app.

## Known gaps for later units

- With `FLYLO_MCP_TOKEN` set, `release_expired_holds` forwards the same
  `Authorization` header to the cron route, so it cannot carry a distinct
  `CRON_SECRET` through MCP.
- The frontend still creates ops-panel runs via `POST /demo-sessions`; moving
  that flow onto prepare/trigger/clear (and dropping the `x-demo-session`
  header path) is frontend work.
- `GET /v1/_ops/errors` still ignores the `demoSessionId` query param the
  frontend sends for scoped error filtering.
- The in-process ops cache is per-instance; cross-instance freshness still
  relies on the 7s TTL plus the direct bound-session lookup on cache miss.
