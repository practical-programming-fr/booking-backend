--------------------------------------------------------------------------------
-- Ops demo sessions (scoped, per-session outage)
--
-- Backs a SCOPED version of the 3am outage: a presenter can break the booking
-- site for THEIR OWN session only, without touching the ~100 other people on
-- the site. The global fare_adjustment_v2 flag (in ops_flags) is unchanged and
-- still breaks the site for everyone; this table holds the set of individual
-- sessions that have opted into a private, time-boxed outage.
--
-- Each row is one active scoped-outage session:
--   * session_id  the caller identity forwarded in the demo-session header
--   * kind        scenario kind, 'outage' for the scoped 500 scenario
--   * created_at  when the scoped session was armed
--   * expires_at  when it lapses (rows past this are treated as inactive)
--
-- Operational/demo data, not customer data. RLS is enabled with no policies so
-- PostgREST/anon cannot read it; the backend reaches it through the same
-- service connection every other query uses. Defensive `if not exists` keeps
-- the migration safe to re-run.
--------------------------------------------------------------------------------

create table if not exists public.ops_demo_sessions (
  session_id  text primary key,
  kind        text not null default 'outage',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists ops_demo_sessions_expires_idx
  on public.ops_demo_sessions (expires_at);

alter table public.ops_demo_sessions enable row level security;
