-- Kasir Nusa POS - supplier return tied to original receipt, batch and stock

create table if not exists public.supplier_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_no text not null,
  idempotency_key text not null,
  receipt_id uuid not null references public.purchase_receipts(id),
  supplier_id uuid not null references public.suppliers(id),
  supplier_name text not null,
  location_id uuid not null references public.stock_locations(id),
  actor_id uuid not null references public.profiles(user_id),
  reason text not null,
  settlement_type text not null check(settlement_type in ('CREDIT_NOTE','REFUND','REPLACEMENT')),
  supplier_reference text,
  total_credit numeric(19,4) not null default 0,
  status text not null default 'POSTED' check(status in ('POSTED','CANCELLED')),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,return_no),
  unique(tenant_id,idempotency_key)
);

create table if not exists public.supplier_return_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.supplier_returns(id) on delete cascade,
  receipt_item_id uuid not null references public.purchase_receipt_items(id),
  batch_id uuid not null references public.inventory_batches(id),
  product_id uuid not null references public.products(id),
  product_name text not null,
  base_qty numeric(19,6) not null check(base_qty>0),
  unit_credit numeric(19,4) not null check(unit_credit>=0),
  line_total numeric(19,4) not null check(line_total>=0),
  stock_unit_cost numeric(19,4) not null check(stock_unit_cost>=0)
);

alter table public.supplier_returns enable row level security;
alter table public.supplier_return_items enable row level security;
drop policy if exists tenant_isolation on public.supplier_returns;
drop policy if exists tenant_isolation on public.supplier_return_items;
create policy tenant_isolation on public.supplier_returns for select to authenticated using(tenant_id=public.current_tenant_id());
create policy tenant_isolation on public.supplier_return_items for select to authenticated using(tenant_id=public.current_tenant_id());
grant select on public.supplier_returns,public.supplier_return_items to authenticated;
grant select,insert,update on public.supplier_returns,public.supplier_return_items to service_role;
create index if not exists supplier_returns_receipt_idx on public.supplier_returns(tenant_id,receipt_id,status,occurred_at desc);
create index if not exists supplier_return_items_receipt_item_idx on public.supplier_return_items(tenant_id,receipt_item_id);

create or replace function public.post_supplier_return(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_receipt_id uuid,
  p_reason text, p_settlement_type text, p_supplier_reference text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.supplier_returns%rowtype; v_receipt public.purchase_receipts%rowtype;
  v_return uuid; v_seq bigint; v_no text; v_item jsonb; v_receipt_item public.purchase_receipt_items%rowtype;
  v_batch public.inventory_batches%rowtype; v_balance public.stock_balances%rowtype;
  v_qty numeric; v_prior numeric; v_total numeric:=0; v_line_total numeric; v_index integer:=0; v_product_name text;
begin
  if not exists(select 1 from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active
    and role in ('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak memiliki hak membuat retur supplier'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi retur supplier wajib diisi'; end if;
  select * into v_existing from public.supplier_returns where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'returnNo',v_existing.return_no,'status',v_existing.status,'totalCredit',v_existing.total_credit,'duplicate',true); end if;
  select * into v_receipt from public.purchase_receipts where id=p_receipt_id and tenant_id=p_tenant_id and status='RECEIVED' for update;
  if not found then raise exception 'Penerimaan pembelian tidak ditemukan'; end if;
  if v_receipt.supplier_id is null then raise exception 'Penerimaan tidak memiliki supplier terdaftar'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Alasan retur supplier wajib diisi'; end if;
  if upper(trim(p_settlement_type)) not in ('CREDIT_NOTE','REFUND','REPLACEMENT') then raise exception 'Penyelesaian retur tidak valid'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Pilih minimal satu barang untuk diretur'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) item group by item->>'receiptItemId' having count(*)>1)
    then raise exception 'Baris penerimaan tidak boleh digandakan'; end if;

  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SUPPLIER_RETURN',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='RTS-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.supplier_returns(
    tenant_id,return_no,idempotency_key,receipt_id,supplier_id,supplier_name,location_id,actor_id,
    reason,settlement_type,supplier_reference,status
  ) values(
    p_tenant_id,v_no,p_idempotency_key,p_receipt_id,v_receipt.supplier_id,v_receipt.supplier_name,
    v_receipt.location_id,p_actor_id,trim(p_reason),upper(trim(p_settlement_type)),
    nullif(trim(p_supplier_reference),''),'POSTED'
  ) returning id into v_return;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_index:=v_index+1; v_qty:=coalesce((v_item->>'baseQty')::numeric,0);
    select * into v_receipt_item from public.purchase_receipt_items
      where id=(v_item->>'receiptItemId')::uuid and receipt_id=p_receipt_id and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Baris penerimaan ke-% tidak ditemukan',v_index; end if;
    select * into v_batch from public.inventory_batches
      where receipt_item_id=v_receipt_item.id and tenant_id=p_tenant_id and location_id=v_receipt.location_id for update;
    if not found then raise exception 'Batch asal untuk baris ke-% tidak ditemukan',v_index; end if;
    select coalesce(sum(item.base_qty),0) into v_prior
      from public.supplier_return_items item join public.supplier_returns doc on doc.id=item.return_id
      where item.tenant_id=p_tenant_id and item.receipt_item_id=v_receipt_item.id and doc.status='POSTED';
    if v_qty<=0 then raise exception 'Jumlah retur pada baris ke-% harus lebih dari nol',v_index; end if;
    if v_prior+v_qty>v_receipt_item.base_qty then raise exception 'Jumlah retur melebihi penerimaan pada baris ke-%',v_index; end if;
    if v_qty>v_batch.available_qty then raise exception 'Stok batch yang tersedia tidak cukup pada baris ke-%',v_index; end if;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_receipt.location_id
      and product_id=v_receipt_item.product_id for update;
    if not found or v_balance.quantity<v_qty then raise exception 'Saldo stok lokasi tidak cukup pada baris ke-%',v_index; end if;
    select name into v_product_name from public.products where id=v_receipt_item.product_id;
    v_line_total:=round(v_qty*v_receipt_item.unit_cost,4); v_total:=v_total+v_line_total;
    insert into public.supplier_return_items(
      tenant_id,return_id,receipt_item_id,batch_id,product_id,product_name,base_qty,unit_credit,line_total,stock_unit_cost
    ) values(
      p_tenant_id,v_return,v_receipt_item.id,v_batch.id,v_receipt_item.product_id,v_product_name,
      v_qty,v_receipt_item.unit_cost,v_line_total,v_balance.avg_cost
    );
    update public.stock_balances set quantity=quantity-v_qty,
      avg_cost=case when quantity-v_qty=0 then 0 else avg_cost end,version=version+1,updated_at=now()
      where location_id=v_receipt.location_id and product_id=v_receipt_item.product_id;
    update public.inventory_batches set available_qty=available_qty-v_qty where id=v_batch.id;
    insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,reference_id)
    values(p_tenant_id,v_batch.id,-v_qty,v_batch.available_qty-v_qty,'SUPPLIER_RETURN',v_return);
    insert into public.stock_ledger(
      tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key
    ) values(
      p_tenant_id,v_receipt.location_id,v_receipt_item.product_id,-v_qty,v_balance.quantity-v_qty,v_balance.avg_cost,
      'SUPPLIER_RETURN',v_return,concat_ws(' · ',v_no,v_receipt.document_no,v_batch.batch_no),
      p_actor_id,p_idempotency_key||':supplier-return:'||v_index
    );
  end loop;
  update public.supplier_returns set total_credit=v_total where id=v_return;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SUPPLIER_RETURN_POSTED','supplier_return',v_return,
    jsonb_build_object('returnNo',v_no,'receiptId',p_receipt_id,'documentNo',v_receipt.document_no,
      'supplierId',v_receipt.supplier_id,'settlementType',upper(trim(p_settlement_type)),
      'totalCredit',v_total,'itemCount',v_index,'reason',trim(p_reason)));
  return jsonb_build_object('id',v_return,'returnNo',v_no,'status','POSTED','totalCredit',v_total,'itemCount',v_index,'duplicate',false);
end $$;

create or replace function public.supplier_return_report_adjustments(
  p_tenant_id uuid, p_location_ids uuid[], p_from date, p_to date, p_timezone text
) returns jsonb language sql stable security definer set search_path=public as $$
  with filtered as (
    select supplier_id,supplier_name,count(*) return_count,sum(total_credit) return_credit
    from public.supplier_returns
    where tenant_id=p_tenant_id and location_id=any(p_location_ids) and status='POSTED'
      and (occurred_at at time zone p_timezone)::date between p_from and p_to
    group by supplier_id,supplier_name
  )
  select jsonb_build_object(
    'totalReturnCredit',coalesce((select sum(return_credit) from filtered),0),
    'suppliers',coalesce((select jsonb_agg(jsonb_build_object(
      'supplierId',supplier_id,'supplierName',supplier_name,'returnCount',return_count,'returnCredit',return_credit
    ) order by return_credit desc) from filtered),'[]'::jsonb)
  )
$$;

revoke all on function public.post_supplier_return(uuid,uuid,text,uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.supplier_return_report_adjustments(uuid,uuid[],date,date,text) from public,anon,authenticated;
grant execute on function public.post_supplier_return(uuid,uuid,text,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.supplier_return_report_adjustments(uuid,uuid[],date,date,text) to service_role;
