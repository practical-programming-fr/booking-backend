--------------------------------------------------------------------------------
-- Ops incident kind
--
-- Distinguish benign, self-healing scenarios from real outages so the frontend
-- orchestrator and the internal console can render them differently. In
-- practice we use two values:
--   * 'outage'  a real incident that breaks the pricing path and needs a fix
--   * 'spike'   a simulated traffic spike that alerts but self-heals (no fix)
--
-- Additive and backward compatible: the column is NOT NULL with a default of
-- 'outage', so every existing row keeps its meaning and the outage flow is
-- unchanged. A check constraint keeps the values to the two we support while
-- still allowing the default.
--------------------------------------------------------------------------------

alter table public.ops_incidents
  add column kind text not null default 'outage';

alter table public.ops_incidents
  add constraint ops_incidents_kind_check
  check (kind in ('outage', 'spike'));
