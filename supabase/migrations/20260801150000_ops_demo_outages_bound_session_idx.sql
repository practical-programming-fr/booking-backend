--------------------------------------------------------------------------------
-- Allow at most one pending or active bind per booking session.
-- Bind no longer arms the outage, so pending rows also need the uniqueness
-- guarantee that previously covered only status=active.
--------------------------------------------------------------------------------

drop index if exists public.ops_demo_outages_active_session_idx;

create unique index ops_demo_outages_bound_session_idx
  on public.ops_demo_outages (booking_session_id)
  where status in ('pending', 'active') and booking_session_id is not null;
