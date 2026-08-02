--------------------------------------------------------------------------------
-- Demo outage runs: operator run handle and ops-console metadata
--
-- run_handle_hash: SHA-256 of the opaque handle returned once at prepare
-- time. trigger/clear look runs up by this hash, so the row UUID alone never
-- grants control. Null on ops-console rows, which are managed by id behind
-- OPS_SHARED_SECRET.
--
-- run_full_arc: whether the frontend incident orchestrator runs the full
-- detect/agents/PR arc for this run (projected via GET /v1/_ops/demo-sessions).
--
-- activation_token_hash becomes nullable: ops-console rows are armed active
-- directly and have no browser activation step.
--------------------------------------------------------------------------------

alter table public.ops_demo_outages
  add column run_handle_hash text unique,
  add column run_full_arc boolean not null default true;

alter table public.ops_demo_outages
  alter column activation_token_hash drop not null;
