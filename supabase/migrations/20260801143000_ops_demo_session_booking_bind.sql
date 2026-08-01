--------------------------------------------------------------------------------
-- Bind a scoped demo outage to a browser booking session
--
-- The existing ops_demo_sessions row remains the source of truth for TTL,
-- Slack routing, incident behavior, and MCP cleanup. These additive columns
-- let a one-time activation URL bind that row to the browser's normal
-- x-booking-session identity, so navigation no longer depends on ?demo=.
--------------------------------------------------------------------------------

alter table public.ops_demo_sessions
  add column if not exists activation_token_hash text;

alter table public.ops_demo_sessions
  add column if not exists bound_booking_session_id uuid;

alter table public.ops_demo_sessions
  add column if not exists activated_at timestamptz;

create unique index if not exists ops_demo_sessions_activation_token_hash_uidx
  on public.ops_demo_sessions (activation_token_hash)
  where activation_token_hash is not null;

create unique index if not exists ops_demo_sessions_bound_booking_session_uidx
  on public.ops_demo_sessions (bound_booking_session_id)
  where bound_booking_session_id is not null;
