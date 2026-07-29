-- Customers may retain a tier while loyalty data is selectively reset.
-- Releasing that optional link keeps the reset atomic and preserves customers
-- when only loyalty/promotions are cleared.

alter table public.customers
  drop constraint if exists customers_tier_id_fkey;

alter table public.customers
  add constraint customers_tier_id_fkey
  foreign key(tier_id)
  references public.customer_tiers(id)
  on delete set null;
