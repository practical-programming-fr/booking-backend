--------------------------------------------------------------------------------
-- Ops flag actor
--
-- Record who last flipped an ops flag so the incident console can show a
-- transparent "outage active since <time> (flipped by <who>)" banner on the
-- single shared toggle. Best-effort: null when no identity is available
-- (e.g. local dev with no SSO in front of the console).
--------------------------------------------------------------------------------

alter table public.ops_flags
  add column updated_by text;
