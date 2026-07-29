-- Kasir Nusa POS - per-product stock management and exact FEFO/FIFO cost layers

create table if not exists public.sale_stock_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  sale_item_id uuid references public.sale_items(id) on delete set null,
  stock_ledger_id uuid not null references public.stock_ledger(id) on delete cascade,
  batch_id uuid not null references public.inventory_batches(id),
  product_id uuid not null references public.products(id),
  line_index integer not null check(line_index>0),
  allocation_order integer not null check(allocation_order>0),
  base_qty numeric(19,6) not null check(base_qty>0),
  unit_cost numeric(19,4) not null check(unit_cost>=0),
  cost_total numeric(19,4) not null check(cost_total>=0),
  restored_qty numeric(19,6) not null default 0 check(restored_qty>=0 and restored_qty<=base_qty),
  occurred_at timestamptz not null default now(),
  unique(stock_ledger_id,batch_id)
);

create index if not exists sale_stock_allocations_sale_idx
  on public.sale_stock_allocations(tenant_id,sale_id,product_id,line_index,allocation_order);
create index if not exists sale_stock_allocations_batch_idx
  on public.sale_stock_allocations(tenant_id,batch_id,occurred_at desc);

create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id),
  product_id uuid not null references public.products(id),
  direction text not null check(direction in ('IN','OUT')),
  quantity numeric(19,6) not null check(quantity>0),
  unit_cost numeric(19,4) not null default 0 check(unit_cost>=0),
  total_cost numeric(19,4) not null default 0 check(total_cost>=0),
  batch_no text,
  expires_on date,
  reason text not null,
  actor_id uuid not null references public.profiles(user_id),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create index if not exists stock_adjustments_product_idx
  on public.stock_adjustments(tenant_id,product_id,occurred_at desc);

alter table public.sale_stock_allocations enable row level security;
alter table public.stock_adjustments enable row level security;
drop policy if exists tenant_isolation on public.sale_stock_allocations;
drop policy if exists tenant_isolation on public.stock_adjustments;
create policy tenant_isolation on public.sale_stock_allocations for select to authenticated
  using(tenant_id=public.current_tenant_id());
create policy tenant_isolation on public.stock_adjustments for select to authenticated
  using(tenant_id=public.current_tenant_id());

-- Ensure every current balance has an equivalent cost layer before exact allocation starts.
do $$
declare v_balance record;v_layer_qty numeric;v_difference numeric;v_lot record;v_take numeric;
begin
  for v_balance in select * from public.stock_balances loop
    select coalesce(sum(available_qty),0) into v_layer_qty
      from public.inventory_batches
      where tenant_id=v_balance.tenant_id and location_id=v_balance.location_id
        and product_id=v_balance.product_id;
    if v_balance.quantity>v_layer_qty then
      v_difference:=v_balance.quantity-v_layer_qty;
      insert into public.inventory_batches(
        tenant_id,location_id,product_id,batch_no,received_qty,available_qty,unit_cost,received_at
      ) values(
        v_balance.tenant_id,v_balance.location_id,v_balance.product_id,'SALDO-MIGRASI',
        v_difference,v_difference,v_balance.avg_cost,now()
      );
    elsif v_layer_qty>v_balance.quantity then
      v_difference:=v_layer_qty-v_balance.quantity;
      for v_lot in
        select * from public.inventory_batches
        where tenant_id=v_balance.tenant_id and location_id=v_balance.location_id
          and product_id=v_balance.product_id and available_qty>0
        order by expires_on asc nulls last,received_at asc,id asc for update
      loop
        exit when v_difference<=0;
        v_take:=least(v_difference,v_lot.available_qty);
        update public.inventory_batches set available_qty=available_qty-v_take where id=v_lot.id;
        v_difference:=v_difference-v_take;
      end loop;
    end if;
  end loop;
end $$;

-- Replace the legacy quantity-only allocator. Dated batches use FEFO; batches without
-- expiry use FIFO. The actual layer cost is retained for profit and audit.
create or replace function public.allocate_sale_fefo()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_remaining numeric;v_lot record;v_take numeric;v_after numeric;
  v_total numeric:=0;v_order integer:=0;v_line_index integer;v_avg numeric:=0;
begin
  if new.event_type<>'SALE' or new.delta>=0 then return new;end if;
  v_remaining:=-new.delta;
  select count(*)+1 into v_line_index from public.sale_items
    where tenant_id=new.tenant_id and sale_id=new.reference_id;
  for v_lot in
    select * from public.inventory_batches
    where tenant_id=new.tenant_id and location_id=new.location_id
      and product_id=new.product_id and available_qty>0
    order by expires_on asc nulls last,received_at asc,id asc for update
  loop
    exit when v_remaining<=0;
    v_order:=v_order+1;v_take:=least(v_remaining,v_lot.available_qty);
    v_after:=v_lot.available_qty-v_take;v_total:=v_total+(v_take*v_lot.unit_cost);
    update public.inventory_batches set available_qty=v_after where id=v_lot.id;
    insert into public.inventory_batch_movements(
      tenant_id,batch_id,delta,balance_after,event_type,reference_id,occurred_at
    ) values(
      new.tenant_id,v_lot.id,-v_take,v_after,'SALE_FEFO',new.reference_id,new.occurred_at
    );
    insert into public.sale_stock_allocations(
      tenant_id,sale_id,stock_ledger_id,batch_id,product_id,line_index,allocation_order,
      base_qty,unit_cost,cost_total,occurred_at
    ) values(
      new.tenant_id,new.reference_id,new.id,v_lot.id,new.product_id,v_line_index,v_order,
      v_take,v_lot.unit_cost,round(v_take*v_lot.unit_cost,4),new.occurred_at
    );
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_remaining>0 then raise exception 'Lapisan stok tidak cukup untuk barang %',new.product_id;end if;
  select coalesce(sum(available_qty*unit_cost)/nullif(sum(available_qty),0),0)
    into v_avg from public.inventory_batches
    where tenant_id=new.tenant_id and location_id=new.location_id and product_id=new.product_id;
  update public.stock_balances set avg_cost=round(v_avg,4)
    where tenant_id=new.tenant_id and location_id=new.location_id and product_id=new.product_id;
  update public.stock_ledger set unit_cost=round(v_total/(-new.delta),4) where id=new.id;
  return new;
end $$;

drop trigger if exists sale_uses_fefo_batches on public.stock_ledger;
create trigger sale_uses_fefo_batches after insert on public.stock_ledger
for each row execute function public.allocate_sale_fefo();

create or replace function public.price_sale_item_from_layers_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_line_index integer;v_cost numeric;v_qty numeric;
begin
  select count(*)+1 into v_line_index from public.sale_items
    where tenant_id=new.tenant_id and sale_id=new.sale_id;
  select coalesce(sum(cost_total),0),coalesce(sum(base_qty),0) into v_cost,v_qty
    from public.sale_stock_allocations
    where tenant_id=new.tenant_id and sale_id=new.sale_id and product_id=new.product_id
      and line_index=v_line_index and sale_item_id is null;
  if v_qty>0 then
    if abs(v_qty-new.base_qty)>0.000001 then
      raise exception 'Alokasi modal batch tidak sama dengan jumlah penjualan';
    end if;
    new.cost_total:=round(v_cost,4);
  end if;
  return new;
end $$;

create or replace function public.attach_sale_item_layers_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_line_index integer;
begin
  select count(*) into v_line_index from public.sale_items
    where tenant_id=new.tenant_id and sale_id=new.sale_id;
  update public.sale_stock_allocations set sale_item_id=new.id
    where tenant_id=new.tenant_id and sale_id=new.sale_id and product_id=new.product_id
      and line_index=v_line_index and sale_item_id is null;
  return new;
end $$;

drop trigger if exists sale_item_uses_layer_cost on public.sale_items;
drop trigger if exists sale_item_attaches_cost_layers on public.sale_items;
create trigger sale_item_uses_layer_cost before insert on public.sale_items
for each row execute function public.price_sale_item_from_layers_v1();
create trigger sale_item_attaches_cost_layers after insert on public.sale_items
for each row execute function public.attach_sale_item_layers_v1();

create or replace function public.reprice_sale_total_from_layers_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_actual numeric;
begin
  if pg_trigger_depth()>1 then return new;end if;
  if not exists(select 1 from public.sale_stock_allocations where tenant_id=new.tenant_id and sale_id=new.id)
    then return new;end if;
  select coalesce(sum(cost_total),0) into v_actual from public.sale_items
    where tenant_id=new.tenant_id and sale_id=new.id;
  if abs(coalesce(new.cost_total,0)-v_actual)>0.0001 then
    update public.sales set cost_total=round(v_actual,4) where id=new.id;
  end if;
  return new;
end $$;

drop trigger if exists sale_total_uses_layer_cost on public.sales;
create trigger sale_total_uses_layer_cost after update of cost_total on public.sales
for each row execute function public.reprice_sale_total_from_layers_v1();

-- A void restores the precise layers used by the original sale.
create or replace function public.restore_voided_sale_layers_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_remaining numeric;v_allocation record;v_take numeric;v_after numeric;v_avg numeric;
begin
  if new.event_type<>'SALE_VOID' or new.delta<=0 then return new;end if;
  v_remaining:=new.delta;
  for v_allocation in
    select allocation.*,batch.available_qty
    from public.sale_stock_allocations allocation
    join public.inventory_batches batch on batch.id=allocation.batch_id
    where allocation.tenant_id=new.tenant_id and allocation.sale_id=new.reference_id
      and allocation.product_id=new.product_id and allocation.restored_qty<allocation.base_qty
    order by allocation.line_index,allocation.allocation_order,allocation.id
    for update of allocation,batch
  loop
    exit when v_remaining<=0;
    v_take:=least(v_remaining,v_allocation.base_qty-v_allocation.restored_qty);
    update public.inventory_batches set available_qty=available_qty+v_take
      where id=v_allocation.batch_id returning available_qty into v_after;
    update public.sale_stock_allocations set restored_qty=restored_qty+v_take where id=v_allocation.id;
    insert into public.inventory_batch_movements(
      tenant_id,batch_id,delta,balance_after,event_type,reference_id,occurred_at
    ) values(
      new.tenant_id,v_allocation.batch_id,v_take,v_after,'SALE_VOID',new.reference_id,new.occurred_at
    );
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_remaining>0 then raise exception 'Lapisan modal penjualan tidak cukup untuk dipulihkan';end if;
  select coalesce(sum(available_qty*unit_cost)/nullif(sum(available_qty),0),0)
    into v_avg from public.inventory_batches
    where tenant_id=new.tenant_id and location_id=new.location_id and product_id=new.product_id;
  update public.stock_balances set avg_cost=round(v_avg,4)
    where tenant_id=new.tenant_id and location_id=new.location_id and product_id=new.product_id;
  return new;
end $$;

drop trigger if exists sale_void_restores_cost_layers on public.stock_ledger;
create trigger sale_void_restores_cost_layers after insert on public.stock_ledger
for each row execute function public.restore_voided_sale_layers_v1();

create or replace function public.adjust_product_stock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_location_id uuid,p_product_id uuid,
  p_direction text,p_quantity numeric,p_unit_cost numeric,p_batch_no text,p_expires_on date,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.stock_adjustments%rowtype;v_adjustment uuid:=gen_random_uuid();
  v_balance public.stock_balances%rowtype;v_direction text:=upper(trim(coalesce(p_direction,'')));
  v_reason text:=nullif(left(trim(coalesce(p_reason,'')),240),'');v_cost numeric;
  v_total numeric:=0;v_remaining numeric;v_lot record;v_take numeric;v_after numeric;
  v_batch uuid;v_batch_no text;v_avg numeric:=0;v_after_qty numeric;
begin
  if nullif(trim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'Kunci penyesuaian stok wajib diisi';end if;
  select * into v_existing from public.stock_adjustments
    where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object(
    'id',v_existing.id,'direction',v_existing.direction,'quantity',v_existing.quantity,
    'unitCost',v_existing.unit_cost,'totalCost',v_existing.total_cost,'duplicate',true
  );end if;
  if v_direction not in ('IN','OUT') then raise exception 'Jenis penyesuaian stok tidak valid';end if;
  if coalesce(p_quantity,0)<=0 then raise exception 'Jumlah penyesuaian harus lebih dari nol';end if;
  if v_reason is null or length(v_reason)<5 then raise exception 'Alasan penyesuaian minimal 5 karakter';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active)
    then raise exception 'Akun penyesuaian stok tidak aktif';end if;
  if not exists(select 1 from public.stock_locations where tenant_id=p_tenant_id and id=p_location_id and active)
    then raise exception 'Lokasi stok tidak valid';end if;
  if not exists(select 1 from public.products where tenant_id=p_tenant_id and id=p_product_id)
    then raise exception 'Produk tidak ditemukan';end if;

  insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost)
    values(p_tenant_id,p_location_id,p_product_id,0,0)
    on conflict(location_id,product_id) do nothing;
  select * into v_balance from public.stock_balances
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=p_product_id for update;
  if v_direction='OUT' and v_balance.quantity<p_quantity then raise exception 'Stok tidak cukup untuk dikurangi';end if;

  insert into public.stock_adjustments(
    id,tenant_id,location_id,product_id,direction,quantity,reason,actor_id,idempotency_key
  ) values(
    v_adjustment,p_tenant_id,p_location_id,p_product_id,v_direction,p_quantity,v_reason,p_actor_id,p_idempotency_key
  );

  if v_direction='IN' then
    v_cost:=coalesce(p_unit_cost,v_balance.avg_cost,0);
    if v_cost<0 then raise exception 'Modal tidak boleh negatif';end if;
    v_total:=p_quantity*v_cost;
    v_batch_no:=coalesce(nullif(trim(p_batch_no),''),'ADJ-'||upper(substr(replace(v_adjustment::text,'-',''),1,8)));
    insert into public.inventory_batches(
      tenant_id,location_id,product_id,batch_no,expires_on,received_qty,available_qty,unit_cost,received_at
    ) values(
      p_tenant_id,p_location_id,p_product_id,v_batch_no,
      p_expires_on,p_quantity,p_quantity,v_cost,now()
    ) returning id into v_batch;
    insert into public.inventory_batch_movements(
      tenant_id,batch_id,delta,balance_after,event_type,reference_id
    ) values(p_tenant_id,v_batch,p_quantity,p_quantity,'STOCK_ADJUSTMENT_IN',v_adjustment);
  else
    v_remaining:=p_quantity;
    for v_lot in
      select * from public.inventory_batches
      where tenant_id=p_tenant_id and location_id=p_location_id and product_id=p_product_id and available_qty>0
      order by expires_on asc nulls last,received_at asc,id asc for update
    loop
      exit when v_remaining<=0;
      v_take:=least(v_remaining,v_lot.available_qty);v_after:=v_lot.available_qty-v_take;
      v_total:=v_total+(v_take*v_lot.unit_cost);
      update public.inventory_batches set available_qty=v_after where id=v_lot.id;
      insert into public.inventory_batch_movements(
        tenant_id,batch_id,delta,balance_after,event_type,reference_id
      ) values(p_tenant_id,v_lot.id,-v_take,v_after,'STOCK_ADJUSTMENT_OUT',v_adjustment);
      v_remaining:=v_remaining-v_take;
    end loop;
    if v_remaining>0 then raise exception 'Lapisan stok tidak cukup untuk dikurangi';end if;
    v_cost:=v_total/p_quantity;
  end if;

  v_after_qty:=v_balance.quantity+case when v_direction='IN' then p_quantity else -p_quantity end;
  select coalesce(sum(available_qty*unit_cost)/nullif(sum(available_qty),0),0)
    into v_avg from public.inventory_batches
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=p_product_id;
  update public.stock_balances set quantity=v_after_qty,avg_cost=round(v_avg,4),
    version=version+1,updated_at=now()
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=p_product_id;
  update public.stock_adjustments set unit_cost=round(v_cost,4),total_cost=round(v_total,4),
    batch_no=case when v_direction='IN' then v_batch_no else null end,
    expires_on=case when v_direction='IN' then p_expires_on else null end
    where id=v_adjustment;
  insert into public.stock_ledger(
    tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,
    reference_id,note,actor_id,idempotency_key
  ) values(
    p_tenant_id,p_location_id,p_product_id,
    case when v_direction='IN' then p_quantity else -p_quantity end,
    v_after_qty,round(v_cost,4),'STOCK_ADJUSTMENT_'||v_direction,
    v_adjustment,v_reason,p_actor_id,p_idempotency_key||':ledger'
  );
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'STOCK_ADJUSTED','stock_adjustment',v_adjustment,
    jsonb_build_object('productId',p_product_id,'locationId',p_location_id,'direction',v_direction,
      'quantity',p_quantity,'unitCost',round(v_cost,4),'totalCost',round(v_total,4),'reason',v_reason)
  );
  return jsonb_build_object(
    'id',v_adjustment,'direction',v_direction,'quantity',p_quantity,'balanceAfter',v_after_qty,
    'unitCost',round(v_cost,4),'totalCost',round(v_total,4),'duplicate',false
  );
end $$;

revoke all on function public.adjust_product_stock_v1(uuid,uuid,text,uuid,uuid,text,numeric,numeric,text,date,text)
  from public,anon,authenticated;
grant execute on function public.adjust_product_stock_v1(uuid,uuid,text,uuid,uuid,text,numeric,numeric,text,date,text)
  to service_role;
grant select,insert,update,delete on public.sale_stock_allocations,public.stock_adjustments to service_role;
grant select on public.sale_stock_allocations,public.stock_adjustments to authenticated;
