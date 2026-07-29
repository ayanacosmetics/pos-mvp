-- Preserve batch traceability during normal operation while allowing an
-- atomic tenant reset to remove purchase documents before batch rows.

alter table public.inventory_batches
  drop constraint if exists inventory_batches_receipt_item_id_fkey;

alter table public.inventory_batches
  add constraint inventory_batches_receipt_item_id_fkey
  foreign key(receipt_item_id)
  references public.purchase_receipt_items(id)
  on delete set null;

alter table public.inventory_batches
  drop constraint if exists inventory_batches_receipt_id_fkey;

alter table public.inventory_batches
  add constraint inventory_batches_receipt_id_fkey
  foreign key(receipt_id)
  references public.purchase_receipts(id)
  on delete set null;
