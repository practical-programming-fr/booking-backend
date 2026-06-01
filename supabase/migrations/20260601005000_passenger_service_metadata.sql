--------------------------------------------------------------------------------
-- Passenger service metadata + booking event history
--
-- These fields support staff/agent demos such as VIP briefings, service
-- recovery, special assistance, and rebooking history.
--------------------------------------------------------------------------------

alter table public.passengers
  add column loyalty_tier text check (
    loyalty_tier is null
    or loyalty_tier in ('invite', 'platinum', 'gold', 'silver', 'member')
  ),
  add column service_tags text[] not null default '{}'::text[],
  add column preferences jsonb not null default '{}'::jsonb;

create table public.booking_events (
  id           bigserial primary key,
  booking_pnr  char(6) not null references public.bookings(pnr) on delete cascade,
  event_type   text not null,
  occurred_at  timestamptz not null default now(),
  actor        text not null default 'system',
  details      jsonb not null default '{}'::jsonb
);

create index booking_events_booking_idx on public.booking_events (booking_pnr, occurred_at);
create index passengers_service_tags_idx on public.passengers using gin (service_tags);

alter table public.booking_events enable row level security;

create policy "booking events own select" on public.booking_events
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.bookings b
      where b.pnr = booking_events.booking_pnr and b.user_id = auth.uid()
    )
  );

