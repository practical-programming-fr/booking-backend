--------------------------------------------------------------------------------
-- Ops rebookings (idempotency ledger + audit)
--
-- Records each rebooking the FlyLo Ops Agent performs through
-- POST /v1/ops/rebook. The unique key (pnr, from_segment_id, to_flight_id)
-- makes rebooking idempotent: a re-run or a double-approve of the same move
-- resolves to the same ledger row instead of moving a passenger twice or
-- throwing. The row also captures the seat assigned on the target flight and
-- the fare delta so the operation is auditable alongside booking_events.
--
-- Operational/demo data, not customer PII. RLS is enabled with no policies so
-- PostgREST/anon cannot read it; the backend reaches it through the same
-- service connection every other query uses. Defensive `if not exists` keeps
-- the migration safe to re-run.
--------------------------------------------------------------------------------

create table if not exists public.ops_rebookings (
  id               bigserial primary key,
  pnr              char(6) not null,
  passenger_id     bigint,
  from_segment_id  bigint not null,
  from_flight_id   uuid,
  to_flight_id     uuid not null,
  to_segment_id    bigint,
  cabin            char(1),
  seat_id          text,
  fare_delta_eur   integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (pnr, from_segment_id, to_flight_id)
);

create index if not exists ops_rebookings_pnr_idx
  on public.ops_rebookings (pnr);

create index if not exists ops_rebookings_to_flight_idx
  on public.ops_rebookings (to_flight_id);

alter table public.ops_rebookings enable row level security;
