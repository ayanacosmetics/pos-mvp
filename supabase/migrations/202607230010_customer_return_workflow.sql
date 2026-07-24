-- Kasir Nusa POS - complete customer return and refund workflow

alter table public.customer_return_items add column if not exists sale_item_id uuid references public.sale_items(id);
alter table public.customer_return_items add column if not exists item_condition text not null default 'SALEABLE';
alter table public.customer_return_items add column if not exists restockable boolean not null default true;
alter table public.customer_return_items add column if not exists original_unit_cost numeric(19,4);
update public.customer_return_items set original_unit_cost=unit_cost where original_unit_cost is null;
alter table public.customer_return_items alter column original_unit_cost set not null;

do $$ begin
  alter table public.customer_return_items add constraint customer_return_items_condition_check
    check(item_condition in ('SALEABLE','OPENED','DAMAGED','EXPIRED'));
exception when duplicate_object then null; end $$;

alter table public.customer_returns add column if not exists refund_method text;
alter table public.customer_returns add column if not exists refund_reference text;
alter table public.customer_returns add column if not exists refund_status text not null default 'COMPLETED';

alter table public.cash_movements add column if not exists reference_type text;
alter table public.cash_movements add column if not exists reference_id uuid;
create unique index if not exists cash_movement_return_once
  on public.cash_movements(tenant_id,reference_type,reference_id)
  where reference_type='CUSTOMER_RETURN' and reference_id is not null;

create table if not exists public.customer_refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.customer_returns(id) on delete cascade,
  amount numeric(19,4) not null check(amount>=0),
  method text not null check(method in ('CASH','TRANSFER','QRIS','EDC')),
  reference text,
  shift_id uuid references public.shifts(id),
  actor_id uuid not null references public.profiles(user_id),
  status text not null default 'COMPLETED' check(status in ('COMPLETED','CANCELLED')),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,return_id)
);

alter table public.customer_refunds enable row level security;
drop policy if exists tenant_isolation on public.customer_refunds;
create policy tenant_isolation on public.customer_refunds for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create index if not exists customer_refunds_lookup on public.customer_refunds(tenant_id,occurred_at desc);
create index if not exists customer_return_items_sale_line_lookup on public.customer_return_items(tenant_id,sale_item_id);

create or replace function public.process_customer_return_v2(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_sale_id uuid,
  p_reason text, p_refund_method text, p_refund_reference text, p_refund_shift_id uuid, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.customer_returns%rowtype; v_sale public.sales%rowtype; v_return uuid; v_refund uuid;
  v_location uuid; v_seq bigint; v_no text; v_item jsonb; v_line public.sale_items%rowtype;
  v_qty numeric; v_prior numeric; v_legacy_prior numeric; v_earlier_capacity numeric; v_line_capacity numeric;
  v_product_prior numeric; v_product_sold numeric; v_unit_refund numeric; v_unit_cost numeric;
  v_total numeric:=0; v_index int:=0; v_balance public.stock_balances%rowtype; v_after public.stock_balances%rowtype;
  v_remaining numeric; v_take numeric; v_lot record; v_batch uuid; v_condition text; v_restockable boolean;
  v_method text:=upper(trim(coalesce(p_refund_method,'ORIGINAL'))); v_shift public.shifts%rowtype;
begin
  if not exists(select 1 from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true and role in ('OWNER','ADMIN'))
    then raise exception 'Hanya Owner atau Admin yang dapat memproses retur'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi retur wajib diisi'; end if;
  select * into v_existing from public.customer_returns where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'returnNo',v_existing.return_no,'total',v_existing.total,'status',v_existing.status,'refundMethod',v_existing.refund_method,'duplicate',true); end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Alasan retur wajib diisi'; end if;

  select * into v_sale from public.sales where id=p_sale_id and tenant_id=p_tenant_id and status='COMPLETED' for update;
  if not found then raise exception 'Transaksi penjualan tidak ditemukan'; end if;
  select id into v_location from public.stock_locations
    where tenant_id=p_tenant_id and outlet_id=v_sale.outlet_id and kind='STORE' order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko untuk transaksi tidak ditemukan'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Barang retur wajib diisi'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'saleItemId' having count(*)>1)
    then raise exception 'Baris penjualan retur tidak boleh digandakan'; end if;

  if v_method='ORIGINAL' then
    v_method:=case
      when lower(v_sale.payment_method) like 'tunai%' then 'CASH'
      when lower(v_sale.payment_method) like 'transfer%' then 'TRANSFER'
      when lower(v_sale.payment_method) like 'qris%' then 'QRIS'
      when lower(v_sale.payment_method) like 'edc%' then 'EDC'
      else 'TRANSFER' end;
  end if;
  if v_method not in ('CASH','TRANSFER','QRIS','EDC') then raise exception 'Metode refund tidak valid'; end if;
  if v_method in ('TRANSFER','QRIS','EDC') and nullif(trim(p_refund_reference),'') is null
    then raise exception 'Referensi refund non-tunai wajib diisi'; end if;
  if v_method='CASH' then
    if p_refund_shift_id is null then raise exception 'Shift aktif wajib dipilih untuk refund tunai'; end if;
    select * into v_shift from public.shifts where id=p_refund_shift_id and tenant_id=p_tenant_id
      and outlet_id=v_sale.outlet_id and cashier_id=p_actor_id and status='OPEN' for update;
    if not found then raise exception 'Refund tunai harus memakai shift aktif milik pengguna pada outlet transaksi'; end if;
  end if;

  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'CUSTOMER_RETURN',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='RTR-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.customer_returns(tenant_id,return_no,idempotency_key,sale_id,location_id,actor_id,reason,refund_method,refund_reference,refund_status)
  values(p_tenant_id,v_no,p_idempotency_key,p_sale_id,v_location,p_actor_id,trim(p_reason),v_method,nullif(trim(p_refund_reference),''),'COMPLETED') returning id into v_return;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_index:=v_index+1;
    if nullif(v_item->>'saleItemId','') is null then raise exception 'Baris penjualan retur wajib dipilih'; end if;
    select * into v_line from public.sale_items where id=(v_item->>'saleItemId')::uuid and tenant_id=p_tenant_id and sale_id=p_sale_id;
    if not found then raise exception 'Baris barang tidak ditemukan pada transaksi'; end if;
    v_qty:=(v_item->>'baseQty')::numeric;
    if v_qty<=0 then raise exception 'Jumlah retur harus lebih dari nol'; end if;
    v_condition:=upper(coalesce(nullif(trim(v_item->>'condition'),''),'SALEABLE'));
    if v_condition not in ('SALEABLE','OPENED','DAMAGED','EXPIRED') then raise exception 'Kondisi barang retur tidak valid'; end if;
    v_restockable:=v_condition='SALEABLE';

    select coalesce(sum(i.base_qty),0) into v_prior
      from public.customer_return_items i join public.customer_returns r on r.id=i.return_id
      where r.tenant_id=p_tenant_id and r.sale_id=p_sale_id and r.status='COMPLETED' and i.sale_item_id=v_line.id;
    v_line_capacity:=greatest(v_line.base_qty-v_prior,0);
    select coalesce(sum(i.base_qty),0) into v_legacy_prior
      from public.customer_return_items i join public.customer_returns r on r.id=i.return_id
      where r.tenant_id=p_tenant_id and r.sale_id=p_sale_id and r.status='COMPLETED'
        and i.sale_item_id is null and i.product_id=v_line.product_id;
    select coalesce(sum(greatest(si.base_qty-coalesce((
      select sum(i.base_qty) from public.customer_return_items i join public.customer_returns r on r.id=i.return_id
      where r.tenant_id=p_tenant_id and r.sale_id=p_sale_id and r.status='COMPLETED' and i.sale_item_id=si.id
    ),0),0)),0) into v_earlier_capacity
      from public.sale_items si where si.tenant_id=p_tenant_id and si.sale_id=p_sale_id
        and si.product_id=v_line.product_id and si.id<v_line.id;
    v_prior:=v_prior+least(v_line_capacity,greatest(v_legacy_prior-v_earlier_capacity,0));
    if v_prior+v_qty>v_line.base_qty then raise exception 'Jumlah retur melebihi sisa pada baris penjualan'; end if;
    select coalesce(sum(base_qty),0) into v_product_sold from public.sale_items
      where tenant_id=p_tenant_id and sale_id=p_sale_id and product_id=v_line.product_id;
    select coalesce(sum(i.base_qty),0) into v_product_prior
      from public.customer_return_items i join public.customer_returns r on r.id=i.return_id
      where r.tenant_id=p_tenant_id and r.sale_id=p_sale_id and r.status='COMPLETED' and i.product_id=v_line.product_id;
    if v_product_prior+v_qty>v_product_sold then raise exception 'Jumlah retur produk melebihi jumlah yang dijual'; end if;

    v_unit_refund:=v_line.total/v_line.base_qty; v_unit_cost:=v_line.cost_total/v_line.base_qty;
    v_total:=v_total+(v_unit_refund*v_qty);
    insert into public.customer_return_items(
      tenant_id,return_id,sale_item_id,product_id,base_qty,unit_refund,line_total,unit_cost,original_unit_cost,item_condition,restockable
    ) values(
      p_tenant_id,v_return,v_line.id,v_line.product_id,v_qty,v_unit_refund,v_unit_refund*v_qty,
      case when v_restockable then v_unit_cost else 0 end,v_unit_cost,v_condition,v_restockable
    );

    if v_restockable then
      insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost) values(p_tenant_id,v_location,v_line.product_id,0,0)
        on conflict(location_id,product_id) do nothing;
      select * into v_balance from public.stock_balances where location_id=v_location and product_id=v_line.product_id for update;
      update public.stock_balances set
        avg_cost=case when v_balance.quantity+v_qty=0 then 0 else ((v_balance.quantity*v_balance.avg_cost)+(v_qty*v_unit_cost))/(v_balance.quantity+v_qty) end,
        quantity=v_balance.quantity+v_qty,version=version+1,updated_at=now()
        where location_id=v_location and product_id=v_line.product_id returning * into v_after;
      insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
      values(p_tenant_id,v_location,v_line.product_id,v_qty,v_after.quantity,v_unit_cost,'CUSTOMER_RETURN',v_return,p_reason,p_actor_id,p_idempotency_key||':return:'||v_index);

      v_remaining:=v_qty;
      for v_lot in
        select b.*,calculation.restorable from public.inventory_batches b
        cross join lateral (
          select -coalesce(sum(case when m.event_type='SALE_FEFO' then m.delta else 0 end),0)
            -coalesce(sum(case when m.event_type='CUSTOMER_RETURN' then m.delta else 0 end),0) restorable
          from public.inventory_batch_movements m
          where m.batch_id=b.id and m.reference_id=p_sale_id and m.event_type in ('SALE_FEFO','CUSTOMER_RETURN')
        ) calculation
        where b.tenant_id=p_tenant_id and b.location_id=v_location and b.product_id=v_line.product_id and calculation.restorable>0
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
        values(p_tenant_id,v_location,v_line.product_id,'RETUR-'||v_no,v_remaining,v_remaining,v_unit_cost,now()) returning id into v_batch;
        insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
        values(p_tenant_id,v_batch,v_remaining,v_remaining,'CUSTOMER_RETURN',p_sale_id);
      end if;
    end if;
  end loop;

  update public.customer_returns set total=v_total where id=v_return;
  insert into public.customer_refunds(tenant_id,return_id,amount,method,reference,shift_id,actor_id)
  values(p_tenant_id,v_return,v_total,v_method,nullif(trim(p_refund_reference),''),case when v_method='CASH' then p_refund_shift_id else null end,p_actor_id)
  returning id into v_refund;
  if v_method='CASH' and v_total>0 then
    insert into public.cash_movements(tenant_id,shift_id,movement_type,amount,note,actor_id,reference_type,reference_id)
    values(p_tenant_id,p_refund_shift_id,'CASH_OUT',v_total,'Refund '||v_no,p_actor_id,'CUSTOMER_RETURN',v_return);
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'RETURN_COMPLETED','customer_return',v_return,
    jsonb_build_object('returnNo',v_no,'saleId',p_sale_id,'total',v_total,'reason',p_reason,'itemCount',v_index,
      'refundMethod',v_method,'refundReference',nullif(trim(p_refund_reference),'')));
  return jsonb_build_object('id',v_return,'returnNo',v_no,'total',v_total,'status','COMPLETED','refundMethod',v_method,'refundId',v_refund,'duplicate',false);
end $$;

revoke execute on function public.process_customer_return(uuid,uuid,text,uuid,uuid,text,jsonb) from service_role;
revoke all on function public.process_customer_return_v2(uuid,uuid,text,uuid,text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.process_customer_return_v2(uuid,uuid,text,uuid,text,text,text,uuid,jsonb) to service_role;
grant select,insert,update,delete on public.customer_refunds to service_role;
grant select on public.customer_refunds to authenticated;
