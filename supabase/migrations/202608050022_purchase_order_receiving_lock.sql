begin;

create or replace function public.guard_active_purchase_order_receiving_v1()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_purchase_order_id uuid;
begin
  if new.status not in ('PENDING','REVISION_REQUIRED','APPROVED') then
    return new;
  end if;

  select nullif(item->>'purchaseOrderId','')::uuid
    into v_purchase_order_id
  from jsonb_array_elements(coalesce(new.items_json,'[]'::jsonb)) item
  where nullif(item->>'purchaseOrderId','') is not null
  limit 1;

  if v_purchase_order_id is null then
    return new;
  end if;

  perform 1
  from public.purchase_orders
  where tenant_id=new.tenant_id and id=v_purchase_order_id
  for update;

  if not found then
    raise exception 'Purchase Order tidak ditemukan';
  end if;

  if exists (
    select 1
    from public.restock_approval_requests other
    where other.tenant_id=new.tenant_id
      and other.id is distinct from new.id
      and other.status in ('PENDING','REVISION_REQUIRED','APPROVED')
      and exists (
        select 1
        from jsonb_array_elements(coalesce(other.items_json,'[]'::jsonb)) other_item
        where nullif(other_item->>'purchaseOrderId','')::uuid=v_purchase_order_id
      )
  ) then
    raise exception 'PO ini sudah memiliki pengajuan penerimaan yang masih diproses';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_active_purchase_order_receiving on public.restock_approval_requests;
create trigger guard_active_purchase_order_receiving
before insert or update of status,items_json on public.restock_approval_requests
for each row execute function public.guard_active_purchase_order_receiving_v1();

revoke all on function public.guard_active_purchase_order_receiving_v1() from public,anon,authenticated;

commit;
