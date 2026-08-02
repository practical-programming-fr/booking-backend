--------------------------------------------------------------------------------
-- Browser-scoped demo outages
--
-- MCP creates a short-lived activation token. The booking frontend opens that
-- token once in the presenter's browser and binds it to the browser's existing
-- booking session. Pricing fails only for requests carrying that session.
--------------------------------------------------------------------------------

create table public.ops_demo_outages (
  id                    uuid primary key default gen_random_uuid(),
  activation_token_hash text not null unique,
  booking_session_id    uuid,
  slack_channel         text,
  status                text not null default 'pending'
                        check (status in ('pending', 'active', 'cleared', 'expired')),
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now(),
  activated_at          timestamptz,
  cleared_at            timestamptz
);

create unique index ops_demo_outages_active_session_idx
  on public.ops_demo_outages (booking_session_id)
  where status = 'active' and booking_session_id is not null;

create index ops_demo_outages_expiry_idx
  on public.ops_demo_outages (expires_at)
  where status in ('pending', 'active');

alter table public.ops_demo_outages enable row level security;
