--------------------------------------------------------------------------------
-- Ops demo sessions scoped metadata
--
-- Adds two nullable, additive columns to public.ops_demo_sessions so a scoped
-- (per-session) outage can carry the per-session routing metadata the booking
-- frontend Ops panel needs:
--   * slack_channel  which Slack channel THIS session's incident posts to
--   * run_full_arc   whether THIS session runs the full incident arc (detect
--                    plus agents plus PR) vs a quiet, visual-outage-only session
--
-- Additive and backward compatible: slack_channel is nullable with no default,
-- and run_full_arc defaults to true so every existing row keeps the current
-- full-arc behaviour. The existing columns (session_id, kind, created_at,
-- expires_at) are unchanged. Defensive `add column if not exists` keeps the
-- migration safe to re-run.
--------------------------------------------------------------------------------

alter table public.ops_demo_sessions
  add column if not exists slack_channel text;

alter table public.ops_demo_sessions
  add column if not exists run_full_arc boolean not null default true;
