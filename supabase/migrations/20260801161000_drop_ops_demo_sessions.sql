--------------------------------------------------------------------------------
-- Drop the legacy scoped-outage table.
--
-- All runtime paths (pricing guard, ops cache, /demo-sessions console routes,
-- MCP tools, /v1/demo/activate) now read and write ops_demo_outages only. The
-- legacy rows carried no data the new path needs, so no backfill.
--------------------------------------------------------------------------------

drop table if exists public.ops_demo_sessions;
