-- Make the purchase document chain self-cleaning. These rows are derived from
-- their parent documents, while purchase_receipts may outlive a deleted PO.

alter table public.supplier_payment_allocations
  drop constraint if exists supplier_payment_allocations_bill_id_fkey;
alter table public.supplier_payment_allocations
  add constraint supplier_payment_allocations_bill_id_fkey
  foreign key(bill_id) references public.supplier_bills(id) on delete cascade;

alter table public.supplier_bills
  drop constraint if exists supplier_bills_receipt_id_fkey;
alter table public.supplier_bills
  add constraint supplier_bills_receipt_id_fkey
  foreign key(receipt_id) references public.purchase_receipts(id) on delete cascade;

alter table public.supplier_returns
  drop constraint if exists supplier_returns_receipt_id_fkey;
alter table public.supplier_returns
  add constraint supplier_returns_receipt_id_fkey
  foreign key(receipt_id) references public.purchase_receipts(id) on delete cascade;

alter table public.supplier_return_items
  drop constraint if exists supplier_return_items_receipt_item_id_fkey;
alter table public.supplier_return_items
  add constraint supplier_return_items_receipt_item_id_fkey
  foreign key(receipt_item_id) references public.purchase_receipt_items(id) on delete cascade;

alter table public.purchase_receipts
  drop constraint if exists purchase_receipts_order_id_fkey;
alter table public.purchase_receipts
  add constraint purchase_receipts_order_id_fkey
  foreign key(order_id) references public.purchase_orders(id) on delete set null;
