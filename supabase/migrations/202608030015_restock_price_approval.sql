-- Restock price approval: draft new products and price changes, then post atomically.
begin;

create table if not exists public.restock_approval_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  approver_id uuid references public.profiles(user_id) on delete set null,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  document_no text not null,
  items_json jsonb not null check(jsonb_typeof(items_json)='array' and jsonb_array_length(items_json)>0),
  proposed_prices_json jsonb not null default '[]'::jsonb check(jsonb_typeof(proposed_prices_json)='array'),
  approved_prices_json jsonb check(approved_prices_json is null or jsonb_typeof(approved_prices_json)='array'),
  status text not null default 'PENDING' check(status in('PENDING','APPROVED','REJECTED','RECEIVED','CANCELLED')),
  requester_note text,
  decision_note text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  received_at timestamptz,
  receipt_id uuid references public.purchase_receipts(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists restock_approval_queue_idx
  on public.restock_approval_requests(tenant_id,status,requested_at desc);
create unique index if not exists restock_approval_active_document_idx
  on public.restock_approval_requests(tenant_id,supplier_id,document_no)
  where status in('PENDING','APPROVED');

alter table public.restock_approval_requests enable row level security;
drop policy if exists restock_approval_requests_tenant_read on public.restock_approval_requests;
create policy restock_approval_requests_tenant_read on public.restock_approval_requests
  for select to authenticated using(tenant_id=public.current_tenant_id());

create or replace function public.submit_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_supplier_id uuid,p_location_id uuid,
  p_document_no text,p_items jsonb,p_proposed_prices jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;v_item jsonb;v_product uuid;v_new_cost numeric;v_last_cost numeric;v_requires boolean:=false;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN','PURCHASING')) then
    raise exception 'Akun tidak memiliki hak mengajukan penerimaan';
  end if;
  if not exists(select 1 from suppliers where tenant_id=p_tenant_id and id=p_supplier_id and active) then raise exception 'Supplier tidak valid';end if;
  if not exists(select 1 from stock_locations where tenant_id=p_tenant_id and id=p_location_id and active) then raise exception 'Lokasi tidak valid';end if;
  if nullif(trim(p_document_no),'') is null then raise exception 'Nomor faktur wajib diisi';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan minimal satu barang';end if;
  if jsonb_typeof(p_proposed_prices)<>'array' then raise exception 'Usulan harga tidak valid';end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce((v_item->>'baseQty')::numeric,0)<=0 or coalesce((v_item->>'unitCost')::numeric,-1)<0 then raise exception 'Jumlah atau modal tidak valid';end if;
    v_product:=nullif(v_item->>'productId','')::uuid;v_new_cost:=(v_item->>'unitCost')::numeric;
    if v_product is null then
      if jsonb_typeof(v_item->'newProduct')<>'object' then raise exception 'Data barang baru tidak lengkap';end if;
      v_requires:=true;
    else
      if not exists(select 1 from products where tenant_id=p_tenant_id and id=v_product and active) then raise exception 'Produk tidak valid';end if;
      select unit_cost into v_last_cost from purchase_receipt_items
        where tenant_id=p_tenant_id and product_id=v_product order by received_at desc,id desc limit 1;
      if v_last_cost is null or v_last_cost is distinct from v_new_cost then v_requires:=true;end if;
    end if;
  end loop;
  if not v_requires then raise exception 'Penerimaan ini tidak memerlukan persetujuan harga';end if;
  insert into restock_approval_requests(tenant_id,requester_id,supplier_id,location_id,document_no,items_json,proposed_prices_json,requester_note)
  values(p_tenant_id,p_actor_id,p_supplier_id,p_location_id,trim(p_document_no),p_items,p_proposed_prices,nullif(trim(p_note),'')) returning id into v_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_PRICE_APPROVAL_REQUESTED','restock_approval',v_id,jsonb_build_object('documentNo',trim(p_document_no),'itemCount',jsonb_array_length(p_items)));
  return jsonb_build_object('id',v_id,'status','PENDING');
end $$;

create or replace function public.decide_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_decision text,
  p_approved_prices jsonb default '[]'::jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_decision text:=upper(trim(p_decision));v_price jsonb;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN')) then raise exception 'Hanya Owner/Admin yang dapat memutuskan';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status<>'PENDING' then raise exception 'Permintaan sudah diputuskan';end if;
  if v_request.requester_id=p_actor_id then raise exception 'Pemohon tidak dapat menyetujui permintaannya sendiri';end if;
  if v_decision='APPROVE' then
    if jsonb_typeof(p_approved_prices)<>'array' then raise exception 'Harga persetujuan tidak valid';end if;
    for v_price in select value from jsonb_array_elements(p_approved_prices) loop
      if coalesce((v_price->>'minBaseQty')::integer,0)<1 or coalesce((v_price->>'unitPriceBase')::numeric,0)<=0 then raise exception 'Harga jual harus lebih dari nol';end if;
    end loop;
    update restock_approval_requests set status='APPROVED',approver_id=p_actor_id,approved_prices_json=p_approved_prices,
      decision_note=nullif(trim(p_note),''),decided_at=now(),updated_at=now() where id=p_request_id;
  elsif v_decision='REJECT' then
    update restock_approval_requests set status='REJECTED',approver_id=p_actor_id,decision_note=nullif(trim(p_note),''),decided_at=now(),updated_at=now() where id=p_request_id;
  else raise exception 'Keputusan tidak valid';end if;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_PRICE_APPROVAL_DECIDED','restock_approval',p_request_id,jsonb_build_object('decision',v_decision));
  return jsonb_build_object('id',p_request_id,'status',case when v_decision='APPROVE' then 'APPROVED' else 'REJECTED' end);
end $$;

create or replace function public.receive_approved_restock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_item jsonb;v_product jsonb;v_result jsonb;v_receipt_items jsonb:='[]'::jsonb;
  v_product_id uuid;v_key text;v_prices jsonb;v_price jsonb;v_new_product jsonb;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak memiliki hak menerima barang';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status='RECEIVED' then return jsonb_build_object('id',v_request.receipt_id,'document_no',v_request.document_no,'status','RECEIVED','duplicate',true);end if;
  if v_request.status<>'APPROVED' then raise exception 'Persetujuan Owner belum tersedia';end if;
  for v_item in select value from jsonb_array_elements(v_request.items_json) loop
    v_product_id:=nullif(v_item->>'productId','')::uuid;v_key:=coalesce(nullif(v_item->>'productKey',''),v_product_id::text);
    if v_product_id is null then
      v_new_product:=v_item->'newProduct';
      v_result:=public.save_product_v6(p_tenant_id,v_request.approver_id,v_new_product);
      v_product_id:=(v_result->>'id')::uuid;
    end if;
    v_prices:=coalesce((select jsonb_agg(value) from jsonb_array_elements(v_request.approved_prices_json) value where value->>'productKey'=v_key),'[]'::jsonb);
    if jsonb_array_length(v_prices)>0 then
      delete from price_rules where tenant_id=p_tenant_id and product_id=v_product_id and starts_at is null and ends_at is null;
      for v_price in select value from jsonb_array_elements(v_prices) loop
        insert into price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
        values(p_tenant_id,v_product_id,v_price->>'customerGroupId',(v_price->>'minBaseQty')::integer,(v_price->>'unitPriceBase')::numeric,10);
      end loop;
      perform public.refresh_safe_customer_prices_v1(p_tenant_id,v_product_id);
    end if;
    v_receipt_items:=v_receipt_items||jsonb_build_array(jsonb_build_object('productId',v_product_id,'baseQty',v_item->'baseQty','unitCost',v_item->'unitCost','batchNo',v_item->'batchNo','expiresOn',v_item->'expiresOn'));
  end loop;
  v_result:=public.receive_purchase(p_tenant_id,p_actor_id,p_idempotency_key,v_request.supplier_id,v_request.location_id,v_request.document_no,v_receipt_items);
  update restock_approval_requests set status='RECEIVED',receipt_id=(v_result->>'id')::uuid,received_at=now(),updated_at=now() where id=p_request_id;
  return v_result||jsonb_build_object('approvalId',p_request_id);
end $$;

revoke all on function public.submit_restock_approval_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.decide_restock_approval_v1(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.submit_restock_approval_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) to service_role;
grant execute on function public.decide_restock_approval_v1(uuid,uuid,uuid,text,jsonb,text) to service_role;
grant execute on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) to service_role;

commit;
