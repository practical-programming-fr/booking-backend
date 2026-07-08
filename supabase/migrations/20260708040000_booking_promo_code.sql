--------------------------------------------------------------------------------
-- Booking promo code + discount
--
-- Adds a config-driven promo capability to bookings. `promo_code` records the
-- applied code (null when none) and `discount_eur` records the whole-EUR amount
-- taken off the fare components (base + seats + meals + surface, never taxes).
--
-- Backward compatible: existing rows default to no discount, so bookings
-- without a promo behave exactly as before.
--------------------------------------------------------------------------------

alter table public.bookings
  add column promo_code text,
  add column discount_eur integer not null default 0 check (discount_eur >= 0);
