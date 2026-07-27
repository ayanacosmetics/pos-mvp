-- Kasir Nusa v2.3.3
-- Fix sync_supplier_bill_trigger reading OLD.receipt_id on purchase_receipts.

create or replace function public.sync_supplier_bill_trigger()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_receipt_id uuid;
begin
  if tg_table_name='purchase_receipts' then
    v_receipt_id:=((case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id')::uuid;
  elsif tg_table_name='purchase_receipt_items' then
    v_receipt_id:=((case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'receipt_id')::uuid;
  elsif tg_table_name='supplier_returns' then
    v_receipt_id:=((case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'receipt_id')::uuid;
  else
    raise exception 'sync_supplier_bill_trigger tidak mendukung tabel %',tg_table_name;
  end if;

  if v_receipt_id is not null then
    perform public.sync_supplier_bill(v_receipt_id);
  end if;

  if tg_op='DELETE' then
    return old;
  end if;
  return new;
end
$$;

comment on function public.sync_supplier_bill_trigger() is
  'Menyelaraskan hutang supplier tanpa mengakses field trigger yang tidak tersedia pada tabel sumber.';
