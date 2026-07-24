-- Kasir Nusa POS - batch inventory, expiry alerts and FEFO allocation

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id),
  product_id uuid not null references public.products(id),
  supplier_id uuid references public.suppliers(id),
  supplier_name text,
  receipt_id uuid references public.purchase_receipts(id),
  receipt_item_id uuid unique references public.purchase_receipt_items(id),
  batch_no text,
  expires_on date,
  received_qty numeric(19,6) not null check(received_qty >= 0),
  available_qty numeric(19,6) not null check(available_qty >= 0),
  unit_cost numeric(19,4) not null default 0,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_batch_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  batch_id uuid not null references public.inventory_batches(id) on delete cascade,
  delta numeric(19,6) not null,
  balance_after numeric(19,6) not null,
  event_type text not null,
  reference_id uuid,
  occurred_at timestamptz not null default now()
);

create index if not exists inventory_batches_fefo_idx
  on public.inventory_batches(tenant_id,location_id,product_id,expires_on,received_at)
  where available_qty > 0;
create index if not exists inventory_batches_expiry_idx
  on public.inventory_batches(tenant_id,expires_on)
  where available_qty > 0;

alter table public.inventory_batches enable row level security;
alter table public.inventory_batch_movements enable row level security;
drop policy if exists tenant_isolation on public.inventory_batches;
drop policy if exists tenant_isolation on public.inventory_batch_movements;
create policy tenant_isolation on public.inventory_batches for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create policy tenant_isolation on public.inventory_batch_movements for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());

create or replace function public.track_received_batch()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_receipt public.purchase_receipts%rowtype; v_batch uuid;
begin
  select * into v_receipt from public.purchase_receipts where id=new.receipt_id;
  insert into public.inventory_batches(
    tenant_id,location_id,product_id,supplier_id,supplier_name,receipt_id,receipt_item_id,
    batch_no,expires_on,received_qty,available_qty,unit_cost,received_at
  ) values (
    new.tenant_id,v_receipt.location_id,new.product_id,new.supplier_id,new.supplier_name,new.receipt_id,new.id,
    new.batch_no,new.expires_on,new.base_qty,new.base_qty,new.unit_cost,new.received_at
  ) on conflict(receipt_item_id) do nothing returning id into v_batch;
  if v_batch is not null then
    insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id,occurred_at)
    values(new.tenant_id,v_batch,new.base_qty,new.base_qty,'PURCHASE_RECEIPT',new.receipt_id,new.received_at);
  end if;
  return new;
end $$;

drop trigger if exists purchase_item_tracks_batch on public.purchase_receipt_items;
create trigger purchase_item_tracks_batch after insert on public.purchase_receipt_items
for each row execute function public.track_received_batch();

-- Backfill every historical receipt as an inventory lot.
insert into public.inventory_batches(
  tenant_id,location_id,product_id,supplier_id,supplier_name,receipt_id,receipt_item_id,
  batch_no,expires_on,received_qty,available_qty,unit_cost,received_at
)
select item.tenant_id,receipt.location_id,item.product_id,item.supplier_id,item.supplier_name,
  item.receipt_id,item.id,item.batch_no,item.expires_on,item.base_qty,item.base_qty,item.unit_cost,item.received_at
from public.purchase_receipt_items item
join public.purchase_receipts receipt on receipt.id=item.receipt_id
on conflict(receipt_item_id) do nothing;

-- Reconcile historical lots with the current stock balance. Past sales are allocated FEFO.
do $$
declare v_balance record; v_lot record; v_lot_total numeric; v_difference numeric; v_take numeric;
begin
  for v_balance in select * from public.stock_balances loop
    select coalesce(sum(available_qty),0) into v_lot_total from public.inventory_batches
    where tenant_id=v_balance.tenant_id and location_id=v_balance.location_id and product_id=v_balance.product_id;
    if v_lot_total > v_balance.quantity then
      v_difference := v_lot_total-v_balance.quantity;
      for v_lot in select id,available_qty from public.inventory_batches
        where tenant_id=v_balance.tenant_id and location_id=v_balance.location_id and product_id=v_balance.product_id and available_qty>0
        order by expires_on asc nulls last,received_at asc,id asc
      loop
        exit when v_difference<=0;
        v_take:=least(v_difference,v_lot.available_qty);
        update public.inventory_batches set available_qty=available_qty-v_take where id=v_lot.id;
        v_difference:=v_difference-v_take;
      end loop;
    elsif v_balance.quantity > v_lot_total then
      v_difference:=v_balance.quantity-v_lot_total;
      insert into public.inventory_batches(
        tenant_id,location_id,product_id,batch_no,received_qty,available_qty,unit_cost,received_at
      ) values (
        v_balance.tenant_id,v_balance.location_id,v_balance.product_id,'SALDO-AWAL',v_difference,v_difference,v_balance.avg_cost,now()
      );
    end if;
  end loop;
end $$;

create or replace function public.allocate_sale_fefo()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_remaining numeric; v_lot record; v_take numeric; v_after numeric;
begin
  if new.event_type<>'SALE' or new.delta>=0 then return new; end if;
  v_remaining := -new.delta;
  for v_lot in select id,available_qty from public.inventory_batches
    where tenant_id=new.tenant_id and location_id=new.location_id and product_id=new.product_id and available_qty>0
    order by expires_on asc nulls last,received_at asc,id asc for update
  loop
    exit when v_remaining<=0;
    v_take:=least(v_remaining,v_lot.available_qty);
    v_after:=v_lot.available_qty-v_take;
    update public.inventory_batches set available_qty=v_after where id=v_lot.id;
    insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id,occurred_at)
    values(new.tenant_id,v_lot.id,-v_take,v_after,'SALE_FEFO',new.reference_id,new.occurred_at);
    v_remaining:=v_remaining-v_take;
  end loop;
  return new;
end $$;

drop trigger if exists sale_uses_fefo_batches on public.stock_ledger;
create trigger sale_uses_fefo_batches after insert on public.stock_ledger
for each row execute function public.allocate_sale_fefo();

grant select,insert,update,delete on public.inventory_batches to service_role;
grant select,insert,update,delete on public.inventory_batch_movements to service_role;
grant select on public.inventory_batches to authenticated;
grant select on public.inventory_batch_movements to authenticated;
