--------------------------------------------------------------------------------
-- Ops errors demo session attribution
--
-- Adds a nullable demo_session_id to the 5xx log so the NOC can attribute a
-- scoped-outage 500 to the individual demo session that caused it. Global
-- outage 500s leave this null, which keeps them distinguishable from scoped
-- ones (the global incident orchestrator keys off the global flag plus the 5xx
-- count, so a null stamp marks the shared, global failures).
--
-- Additive and backward compatible: the column is nullable with no default, so
-- every existing row keeps its meaning and the standard (unstamped) insert path
-- keeps working. Defensive `if not exists` keeps the migration safe to re-run.
--------------------------------------------------------------------------------

alter table public.ops_errors
  add column if not exists demo_session_id text;
