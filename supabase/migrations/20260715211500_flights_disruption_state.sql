--------------------------------------------------------------------------------
-- Flights disruption state
--
-- Groundwork for the FlyLo Ops Agent disruption/recovery endpoints. The
-- flights table already carries a `status` column; this migration widens the
-- allowed set to include 'delayed' (so a disruption can be modelled short of a
-- full cancellation) and adds two audit columns that record when and why a
-- flight was disrupted.
--
-- All statements are guarded so the migration is safe to re-run. The check
-- constraint is dropped and re-created rather than altered in place, because
-- Postgres has no "alter constraint" for check bodies; the drop uses
-- `if exists` so a fresh database (where the constraint may be named
-- differently) does not error.
--------------------------------------------------------------------------------

alter table public.flights
  drop constraint if exists flights_status_check;

alter table public.flights
  add constraint flights_status_check check (
    status in ('scheduled', 'boarding', 'departed', 'arrived', 'delayed', 'cancelled')
  );

alter table public.flights
  add column if not exists disrupted_at timestamptz;

alter table public.flights
  add column if not exists disruption_reason text;
