--------------------------------------------------------------------------------
-- Retire the legacy scoped-outage table without deleting it yet.
--
-- All runtime paths now read and write ops_demo_outages only. Rename keeps an
-- observation window so we can restore the table if a forgotten caller still
-- needs it. Drop in a later migration after a clean canary window.
--------------------------------------------------------------------------------

alter table if exists public.ops_demo_sessions
  rename to ops_demo_sessions_retired;
