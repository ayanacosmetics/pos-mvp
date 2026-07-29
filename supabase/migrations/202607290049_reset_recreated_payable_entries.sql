-- Deleting purchase items can re-run the supplier bill synchronizer and
-- recreate payable ledger entries. Those entries are derived supplier data,
-- so they must follow the supplier during a full tenant reset.

alter table public.supplier_payable_entries
  drop constraint if exists supplier_payable_entries_supplier_id_fkey;

alter table public.supplier_payable_entries
  add constraint supplier_payable_entries_supplier_id_fkey
  foreign key(supplier_id)
  references public.suppliers(id)
  on delete cascade;
