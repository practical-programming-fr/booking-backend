--------------------------------------------------------------------------------
-- Ops incident console
--
-- Backing tables for the incident-response demo:
--   * ops_flags     runtime toggles (no redeploy) that gate demo behaviour
--   * ops_errors    a lightweight 5xx log the ops dashboard and agents read
--   * ops_incidents one row per incident with an append-only event timeline
--
-- These are operational/demo tables, not customer data. RLS is enabled with
-- no policies so PostgREST/anon cannot read them; the backend reaches them
-- through the service connection used by every other query.
--------------------------------------------------------------------------------

create table public.ops_flags (
  key         text primary key,
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- The 3am outage toggle. Seeded off so production is healthy until a
-- presenter flips it (or the reset workflow re-arms the dormant state).
insert into public.ops_flags (key, enabled) values ('fare_adjustment_v2', false);

create table public.ops_errors (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  method       text not null,
  path         text not null,
  status       integer not null,
  message      text not null,
  stack        text
);

create index ops_errors_occurred_idx on public.ops_errors (occurred_at desc);

create table public.ops_incidents (
  id                   uuid primary key default gen_random_uuid(),
  status               text not null default 'open',
  title                text not null default 'Booking API incident',
  started_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  events               jsonb not null default '[]'::jsonb,
  summarizer_agent_id  text,
  fixer_agent_id       text,
  summary_posted       boolean not null default false,
  pr_url               text,
  pr_number            integer,
  pr_posted            boolean not null default false,
  green_ticks          integer not null default 0,
  updated_at           timestamptz not null default now()
);

create index ops_incidents_status_idx on public.ops_incidents (status, started_at desc);

alter table public.ops_flags enable row level security;
alter table public.ops_errors enable row level security;
alter table public.ops_incidents enable row level security;
