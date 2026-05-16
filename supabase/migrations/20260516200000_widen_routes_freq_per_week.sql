-- The initial schema constrained `routes.freq_per_week` to 1..28 (max
-- 4 flights/day), but the seed catalog reflects realistic hub-to-hub
-- frequencies — e.g. LHR↔CDG at 5/day = 35/week. Widen the upper bound
-- so the catalog round-trips cleanly without misrepresenting the network.
--
-- 70/week (10/day) is well above anything any real carrier operates on a
-- single city pair, so it's a safe ceiling that still catches typos.

alter table public.routes drop constraint if exists routes_freq_per_week_check;
alter table public.routes
  add constraint routes_freq_per_week_check
  check (freq_per_week between 1 and 70);
