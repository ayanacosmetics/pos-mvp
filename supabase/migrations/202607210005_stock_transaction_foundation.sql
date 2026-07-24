-- Kasir Nusa POS - atomic cloud foundation for transfer, stock count and customer return

alter table public.inventory_batches
  add column if not exists source_batch_id uuid references public.inventory_batches(id);

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_no text not null,
  idempotency_key text not null,
  from_location_id uuid not null references public.stock_locations(id),
  to_location_id uuid not null references public.stock_locations(id),
  actor_id uuid not null references public.profiles(user_id),
  status text not null default 'RECEIVED' check(status in ('RECEIVED','CANCELLED')),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,transfer_no), unique(tenant_id,idempotency_key),
  check(from_location_id<>to_location_id)
);

create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  base_qty numeric(19,6) not null check(base_qty>0),
  unit_cost numeric(19,4) not null check(unit_cost>=0)
);

create table if not exists public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  count_no text not null,
  idempotency_key text not null,
  location_id uuid not null references public.stock_locations(id),
  actor_id uuid not null references public.profiles(user_id),
  status text not null default 'POSTED' check(status in ('POSTED','CANCELLED')),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,count_no), unique(tenant_id,idempotency_key)
);

create table if not exists public.stock_count_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  product_id uuid not null references public.products(id),
  system_qty numeric(19,6) not null,
  counted_qty numeric(19,6) not null check(counted_qty>=0),
  delta numeric(19,6) not null,
  unit_cost numeric(19,4) not null check(unit_cost>=0)
);

create table if not exists public.customer_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_no text not null,
  idempotency_key text not null,
  sale_id uuid not null references public.sales(id),
  location_id uuid not null references public.stock_locations(id),
  actor_id uuid not null references public.profiles(user_id),
  reason text not null,
  total numeric(19,4) not null default 0 check(total>=0),
  status text not null default 'COMPLETED' check(status in ('COMPLETED','CANCELLED')),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,return_no), unique(tenant_id,idempotency_key)
);

create table if not exists public.customer_return_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.customer_returns(id) on delete cascade,
  product_id uuid not null references public.products(id),
  base_qty numeric(19,6) not null check(base_qty>0),
  unit_refund numeric(19,4) not null check(unit_refund>=0),
  line_total numeric(19,4) not null check(line_total>=0),
  unit_cost numeric(19,4) not null check(unit_cost>=0)
);

do $$
declare table_name text;
begin
  foreach table_name in array array['stock_transfers','stock_transfer_items','stock_counts','stock_count_items','customer_returns','customer_return_items']
  loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('drop policy if exists tenant_isolation on public.%I',table_name);
    execute format('create policy tenant_isolation on public.%I for all to authenticated using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id())',table_name);
  end loop;
end $$;

create index if not exists stock_transfers_lookup on public.stock_transfers(tenant_id,occurred_at desc);
create index if not exists stock_counts_lookup on public.stock_counts(tenant_id,occurred_at desc);
create index if not exists customer_returns_sale_lookup on public.customer_returns(tenant_id,sale_id,status);
create index if not exists customer_return_items_lookup on public.customer_return_items(return_id,product_id);

create or replace function public.post_stock_transfer(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text,
  p_from_location_id uuid, p_to_location_id uuid, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.stock_transfers%rowtype; v_transfer uuid; v_seq bigint; v_no text;
  v_item jsonb; v_product uuid; v_qty numeric; v_index int:=0; v_source public.stock_balances%rowtype;
  v_dest public.stock_balances%rowtype; v_remaining numeric; v_take numeric; v_lot record; v_dest_batch uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi transfer wajib diisi'; end if;
  select * into v_existing from public.stock_transfers where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'transferNo',v_existing.transfer_no,'status',v_existing.status,'duplicate',true); end if;
  if p_from_location_id=p_to_location_id then raise exception 'Lokasi asal dan tujuan harus berbeda'; end if;
  if not exists(select 1 from public.stock_locations where id=p_from_location_id and tenant_id=p_tenant_id)
    or not exists(select 1 from public.stock_locations where id=p_to_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi transfer tidak valid'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Barang transfer wajib diisi'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*)>1) then raise exception 'Produk transfer tidak boleh digandakan'; end if;

  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'TRANSFER',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='TRF-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.stock_transfers(tenant_id,transfer_no,idempotency_key,from_location_id,to_location_id,actor_id)
  values(p_tenant_id,v_no,p_idempotency_key,p_from_location_id,p_to_location_id,p_actor_id) returning id into v_transfer;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_index:=v_index+1; v_product:=(v_item->>'productId')::uuid; v_qty:=(v_item->>'baseQty')::numeric;
    if v_qty<=0 then raise exception 'Jumlah transfer harus lebih dari nol'; end if;
    if not exists(select 1 from public.products where id=v_product and tenant_id=p_tenant_id) then raise exception 'Produk transfer tidak valid'; end if;
    select * into v_source from public.stock_balances where tenant_id=p_tenant_id and location_id=p_from_location_id and product_id=v_product for update;
    if not found or v_source.quantity<v_qty then raise exception 'Stok produk tidak cukup untuk transfer'; end if;
    insert into public.stock_transfer_items(tenant_id,transfer_id,product_id,base_qty,unit_cost)
    values(p_tenant_id,v_transfer,v_product,v_qty,v_source.avg_cost);
    update public.stock_balances set quantity=quantity-v_qty,version=version+1,updated_at=now()
      where tenant_id=p_tenant_id and location_id=p_from_location_id and product_id=v_product;
    insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost,version,updated_at)
    values(p_tenant_id,p_to_location_id,v_product,v_qty,v_source.avg_cost,1,now())
    on conflict(location_id,product_id) do update set
      avg_cost=case when public.stock_balances.quantity+excluded.quantity=0 then 0 else
        ((public.stock_balances.quantity*public.stock_balances.avg_cost)+(excluded.quantity*excluded.avg_cost))/(public.stock_balances.quantity+excluded.quantity) end,
      quantity=public.stock_balances.quantity+excluded.quantity,version=public.stock_balances.version+1,updated_at=now();
    select * into v_dest from public.stock_balances where location_id=p_to_location_id and product_id=v_product;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key)
    values
      (p_tenant_id,p_from_location_id,v_product,-v_qty,v_source.quantity-v_qty,v_source.avg_cost,'TRANSFER_OUT',v_transfer,p_actor_id,p_idempotency_key||':out:'||v_index),
      (p_tenant_id,p_to_location_id,v_product,v_qty,v_dest.quantity,v_source.avg_cost,'TRANSFER_IN',v_transfer,p_actor_id,p_idempotency_key||':in:'||v_index);

    v_remaining:=v_qty;
    for v_lot in select * from public.inventory_batches where tenant_id=p_tenant_id and location_id=p_from_location_id and product_id=v_product and available_qty>0
      order by expires_on asc nulls last,received_at asc,id asc for update
    loop
      exit when v_remaining<=0; v_take:=least(v_remaining,v_lot.available_qty);
      update public.inventory_batches set available_qty=available_qty-v_take where id=v_lot.id;
      insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
      values(p_tenant_id,v_lot.id,-v_take,v_lot.available_qty-v_take,'TRANSFER_OUT',v_transfer);
      insert into public.inventory_batches(tenant_id,location_id,product_id,supplier_id,supplier_name,batch_no,expires_on,received_qty,available_qty,unit_cost,received_at,source_batch_id)
      values(p_tenant_id,p_to_location_id,v_product,v_lot.supplier_id,v_lot.supplier_name,v_lot.batch_no,v_lot.expires_on,v_take,v_take,v_lot.unit_cost,now(),v_lot.id)
      returning id into v_dest_batch;
      insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
      values(p_tenant_id,v_dest_batch,v_take,v_take,'TRANSFER_IN',v_transfer);
      v_remaining:=v_remaining-v_take;
    end loop;
    if v_remaining>0 then raise exception 'Saldo batch tidak cukup untuk transfer. Jalankan rekonsiliasi stok.'; end if;
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'STOCK_TRANSFERRED','stock_transfer',v_transfer,jsonb_build_object('transferNo',v_no,'fromLocationId',p_from_location_id,'toLocationId',p_to_location_id,'itemCount',v_index));
  return jsonb_build_object('id',v_transfer,'transferNo',v_no,'status','RECEIVED','duplicate',false);
end $$;

create or replace function public.post_stock_count(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_location_id uuid, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.stock_counts%rowtype; v_count uuid; v_seq bigint; v_no text; v_item jsonb; v_product uuid;
  v_counted numeric; v_delta numeric; v_index int:=0; v_balance public.stock_balances%rowtype;
  v_remaining numeric; v_take numeric; v_lot record; v_batch uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi opname wajib diisi'; end if;
  select * into v_existing from public.stock_counts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'countNo',v_existing.count_no,'status',v_existing.status,'duplicate',true); end if;
  if not exists(select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi opname tidak valid'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Barang opname wajib diisi'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*)>1) then raise exception 'Produk opname tidak boleh digandakan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'STOCK_COUNT',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='OPN-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.stock_counts(tenant_id,count_no,idempotency_key,location_id,actor_id)
  values(p_tenant_id,v_no,p_idempotency_key,p_location_id,p_actor_id) returning id into v_count;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_index:=v_index+1; v_product:=(v_item->>'productId')::uuid; v_counted:=(v_item->>'countedQty')::numeric;
    if v_counted<0 then raise exception 'Jumlah fisik opname tidak boleh negatif'; end if;
    insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost) values(p_tenant_id,p_location_id,v_product,0,0)
      on conflict(location_id,product_id) do nothing;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product for update;
    v_delta:=v_counted-v_balance.quantity;
    insert into public.stock_count_items(tenant_id,count_id,product_id,system_qty,counted_qty,delta,unit_cost)
    values(p_tenant_id,v_count,v_product,v_balance.quantity,v_counted,v_delta,v_balance.avg_cost);
    update public.stock_balances set quantity=v_counted,version=version+1,updated_at=now() where location_id=p_location_id and product_id=v_product;
    if v_delta<>0 then
      insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
      values(p_tenant_id,p_location_id,v_product,v_delta,v_counted,v_balance.avg_cost,'STOCK_COUNT',v_count,'Fisik '||v_counted,p_actor_id,p_idempotency_key||':count:'||v_index);
    end if;
    if v_delta<0 then
      v_remaining:=-v_delta;
      for v_lot in select * from public.inventory_batches where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product and available_qty>0
        order by expires_on asc nulls last,received_at asc,id asc for update
      loop
        exit when v_remaining<=0; v_take:=least(v_remaining,v_lot.available_qty);
        update public.inventory_batches set available_qty=available_qty-v_take where id=v_lot.id;
        insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
        values(p_tenant_id,v_lot.id,-v_take,v_lot.available_qty-v_take,'STOCK_COUNT_OUT',v_count);
        v_remaining:=v_remaining-v_take;
      end loop;
      if v_remaining>0 then raise exception 'Saldo batch tidak cukup untuk opname. Jalankan rekonsiliasi stok.'; end if;
    elsif v_delta>0 then
      insert into public.inventory_batches(tenant_id,location_id,product_id,batch_no,received_qty,available_qty,unit_cost,received_at)
      values(p_tenant_id,p_location_id,v_product,'OPNAME-'||v_no,v_delta,v_delta,v_balance.avg_cost,now()) returning id into v_batch;
      insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
      values(p_tenant_id,v_batch,v_delta,v_delta,'STOCK_COUNT_IN',v_count);
    end if;
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'STOCK_COUNT_POSTED','stock_count',v_count,jsonb_build_object('countNo',v_no,'locationId',p_location_id,'itemCount',v_index));
  return jsonb_build_object('id',v_count,'countNo',v_no,'status','POSTED','duplicate',false);
end $$;

create or replace function public.process_customer_return(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_sale_id uuid,
  p_location_id uuid, p_reason text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.customer_returns%rowtype; v_return uuid; v_seq bigint; v_no text; v_item jsonb; v_product uuid;
  v_qty numeric; v_sold_qty numeric; v_sold_total numeric; v_sold_cost numeric; v_prior numeric; v_unit_refund numeric; v_unit_cost numeric;
  v_total numeric:=0; v_index int:=0; v_balance public.stock_balances%rowtype; v_after public.stock_balances%rowtype;
  v_remaining numeric; v_take numeric; v_lot record; v_batch uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi retur wajib diisi'; end if;
  select * into v_existing from public.customer_returns where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'returnNo',v_existing.return_no,'total',v_existing.total,'status',v_existing.status,'duplicate',true); end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Alasan retur wajib diisi'; end if;
  if not exists(select 1 from public.sales where id=p_sale_id and tenant_id=p_tenant_id and status='COMPLETED') then raise exception 'Transaksi penjualan tidak ditemukan'; end if;
  if not exists(select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi retur tidak valid'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Barang retur wajib diisi'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*)>1) then raise exception 'Produk retur tidak boleh digandakan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'CUSTOMER_RETURN',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='RTR-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.customer_returns(tenant_id,return_no,idempotency_key,sale_id,location_id,actor_id,reason)
  values(p_tenant_id,v_no,p_idempotency_key,p_sale_id,p_location_id,p_actor_id,p_reason) returning id into v_return;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_index:=v_index+1; v_product:=(v_item->>'productId')::uuid; v_qty:=(v_item->>'baseQty')::numeric;
    if v_qty<=0 then raise exception 'Jumlah retur harus lebih dari nol'; end if;
    select coalesce(sum(base_qty),0),coalesce(sum(total),0),coalesce(sum(cost_total),0) into v_sold_qty,v_sold_total,v_sold_cost
      from public.sale_items where tenant_id=p_tenant_id and sale_id=p_sale_id and product_id=v_product;
    if v_sold_qty=0 then raise exception 'Produk retur tidak terdapat pada transaksi penjualan'; end if;
    select coalesce(sum(i.base_qty),0) into v_prior from public.customer_return_items i join public.customer_returns r on r.id=i.return_id
      where r.tenant_id=p_tenant_id and r.sale_id=p_sale_id and r.status='COMPLETED' and i.product_id=v_product;
    if v_prior+v_qty>v_sold_qty then raise exception 'Jumlah retur melebihi jumlah yang dijual'; end if;
    v_unit_refund:=v_sold_total/v_sold_qty; v_unit_cost:=v_sold_cost/v_sold_qty; v_total:=v_total+(v_unit_refund*v_qty);
    insert into public.customer_return_items(tenant_id,return_id,product_id,base_qty,unit_refund,line_total,unit_cost)
    values(p_tenant_id,v_return,v_product,v_qty,v_unit_refund,v_unit_refund*v_qty,v_unit_cost);
    insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost) values(p_tenant_id,p_location_id,v_product,0,0)
      on conflict(location_id,product_id) do nothing;
    select * into v_balance from public.stock_balances where location_id=p_location_id and product_id=v_product for update;
    update public.stock_balances set
      avg_cost=((v_balance.quantity*v_balance.avg_cost)+(v_qty*v_unit_cost))/(v_balance.quantity+v_qty),
      quantity=v_balance.quantity+v_qty,version=version+1,updated_at=now()
      where location_id=p_location_id and product_id=v_product returning * into v_after;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
    values(p_tenant_id,p_location_id,v_product,v_qty,v_after.quantity,v_unit_cost,'CUSTOMER_RETURN',v_return,p_reason,p_actor_id,p_idempotency_key||':return:'||v_index);

    v_remaining:=v_qty;
    for v_lot in
      select b.*,calculation.restorable
      from public.inventory_batches b
      cross join lateral (
        select -coalesce(sum(case when m.event_type='SALE_FEFO' then m.delta else 0 end),0)
          -coalesce(sum(case when m.event_type='CUSTOMER_RETURN' then m.delta else 0 end),0) restorable
        from public.inventory_batch_movements m
        where m.batch_id=b.id and m.reference_id=p_sale_id and m.event_type in ('SALE_FEFO','CUSTOMER_RETURN')
      ) calculation
      where b.tenant_id=p_tenant_id and b.location_id=p_location_id and b.product_id=v_product and calculation.restorable>0
      order by b.expires_on asc nulls last,b.received_at asc,b.id asc for update of b
    loop
      exit when v_remaining<=0; v_take:=least(v_remaining,v_lot.restorable);
      update public.inventory_batches set available_qty=available_qty+v_take where id=v_lot.id;
      insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
      values(p_tenant_id,v_lot.id,v_take,v_lot.available_qty+v_take,'CUSTOMER_RETURN',p_sale_id);
      v_remaining:=v_remaining-v_take;
    end loop;
    if v_remaining>0 then
      insert into public.inventory_batches(tenant_id,location_id,product_id,batch_no,received_qty,available_qty,unit_cost,received_at)
      values(p_tenant_id,p_location_id,v_product,'RETUR-'||v_no,v_remaining,v_remaining,v_unit_cost,now()) returning id into v_batch;
      insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
      values(p_tenant_id,v_batch,v_remaining,v_remaining,'CUSTOMER_RETURN',p_sale_id);
    end if;
  end loop;
  update public.customer_returns set total=v_total where id=v_return;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'RETURN_COMPLETED','customer_return',v_return,jsonb_build_object('returnNo',v_no,'saleId',p_sale_id,'total',v_total,'reason',p_reason,'itemCount',v_index));
  return jsonb_build_object('id',v_return,'returnNo',v_no,'total',v_total,'status','COMPLETED','duplicate',false);
end $$;

revoke all on function public.post_stock_transfer(uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.post_stock_count(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.process_customer_return(uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.post_stock_transfer(uuid,uuid,text,uuid,uuid,jsonb) to service_role;
grant execute on function public.post_stock_count(uuid,uuid,text,uuid,jsonb) to service_role;
grant execute on function public.process_customer_return(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
grant select,insert,update,delete on public.stock_transfers,public.stock_transfer_items,public.stock_counts,public.stock_count_items,public.customer_returns,public.customer_return_items to service_role;
grant select on public.stock_transfers,public.stock_transfer_items,public.stock_counts,public.stock_count_items,public.customer_returns,public.customer_return_items to authenticated;
