-- Keep a price-approval receipt attached to its original Purchase Order.
begin;

create or replace function public.profile_can_receive_purchase_v1(p_tenant_id uuid,p_actor_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active
      and (role in('OWNER','ADMIN','PURCHASING') or 'purchasing.receive'=any(coalesce(custom_permissions,array[]::text[])))
  )
$$;

create or replace function public.submit_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_supplier_id uuid,p_location_id uuid,
  p_document_no text,p_items jsonb,p_proposed_prices jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;v_item jsonb;v_product uuid;v_new_cost numeric;v_last_cost numeric;v_requires boolean:=false;
begin
  if not public.profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak mengajukan penerimaan';end if;
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
      select unit_cost into v_last_cost from purchase_receipt_items where tenant_id=p_tenant_id and product_id=v_product order by received_at desc,id desc limit 1;
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

-- The API supports granular staff permissions. Keep the database authorization in sync,
-- otherwise a Cashier with purchasing.receive can open the screen but cannot post stock.
create or replace function public.receive_purchase(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_supplier_id uuid,
  p_location_id uuid,p_document_no text,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_receipt_id uuid;v_existing public.purchase_receipts%rowtype;v_supplier_name text;v_item jsonb;
  v_product_id uuid;v_qty numeric(19,6);v_cost numeric(19,4);v_batch text;v_expires date;
  v_balance_qty numeric(19,6);v_balance_cost numeric(19,4);v_new_qty numeric(19,6);
  v_new_avg numeric(19,4);v_line integer:=0;v_total numeric(19,4):=0;
begin
  if not public.profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak menerima pembelian';end if;
  select name into v_supplier_name from public.suppliers where id=p_supplier_id and tenant_id=p_tenant_id and active;
  if v_supplier_name is null then raise exception 'Supplier tidak valid';end if;
  if not exists(select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi penerimaan tidak valid';end if;
  if nullif(btrim(p_document_no),'') is null then raise exception 'Nomor dokumen pembelian wajib diisi';end if;
  if nullif(btrim(p_idempotency_key),'') is null then raise exception 'Idempotency key wajib diisi';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan minimal satu barang restok';end if;
  select * into v_existing from public.purchase_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'document_no',v_existing.document_no,'supplier_name',v_existing.supplier_name,'occurred_at',v_existing.occurred_at,'status',v_existing.status,'duplicate',true);end if;
  insert into public.purchase_receipts(tenant_id,supplier_id,supplier_name,location_id,document_no,idempotency_key,actor_id,status)
  values(p_tenant_id,p_supplier_id,v_supplier_name,p_location_id,btrim(p_document_no),p_idempotency_key,p_actor_id,'RECEIVED')
  on conflict(tenant_id,idempotency_key) do nothing returning id into v_receipt_id;
  if v_receipt_id is null then
    select * into v_existing from public.purchase_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
    return jsonb_build_object('id',v_existing.id,'document_no',v_existing.document_no,'supplier_name',v_existing.supplier_name,'occurred_at',v_existing.occurred_at,'status',v_existing.status,'duplicate',true);
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line:=v_line+1;v_product_id:=nullif(v_item->>'productId','')::uuid;v_qty:=(v_item->>'baseQty')::numeric;
    v_cost:=(v_item->>'unitCost')::numeric;v_batch:=nullif(btrim(v_item->>'batchNo'),'');v_expires:=nullif(v_item->>'expiresOn','')::date;
    if not exists(select 1 from public.products where id=v_product_id and tenant_id=p_tenant_id and active) then raise exception 'Produk pada baris % tidak valid',v_line;end if;
    if v_qty is null or v_qty<=0 then raise exception 'Jumlah pada baris % harus lebih dari nol',v_line;end if;
    if v_cost is null or v_cost<0 then raise exception 'Modal pada baris % tidak valid',v_line;end if;
    insert into public.purchase_receipt_items(tenant_id,receipt_id,product_id,base_qty,unit_cost,batch_no,expires_on,supplier_id,supplier_name,document_no,received_at)
    values(p_tenant_id,v_receipt_id,v_product_id,v_qty,v_cost,v_batch,v_expires,p_supplier_id,v_supplier_name,btrim(p_document_no),now());
    insert into public.stock_balances(tenant_id,location_id,product_id) values(p_tenant_id,p_location_id,v_product_id) on conflict(location_id,product_id) do nothing;
    select quantity,avg_cost into v_balance_qty,v_balance_cost from public.stock_balances where location_id=p_location_id and product_id=v_product_id for update;
    v_new_qty:=v_balance_qty+v_qty;
    v_new_avg:=case when v_new_qty=0 then 0 when v_balance_qty<=0 then v_cost else round(((v_balance_qty*v_balance_cost)+(v_qty*v_cost))/v_new_qty,4) end;
    update public.stock_balances set quantity=v_new_qty,avg_cost=v_new_avg,version=version+1,updated_at=now() where location_id=p_location_id and product_id=v_product_id;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
    values(p_tenant_id,p_location_id,v_product_id,v_qty,v_new_qty,v_cost,'PURCHASE_RECEIPT',v_receipt_id,concat_ws(' · ',btrim(p_document_no),case when v_batch is not null then 'batch '||v_batch end),p_actor_id,p_idempotency_key||':stock:'||v_line);
    v_total:=v_total+(v_qty*v_cost);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_RECEIVED','purchase_receipt',v_receipt_id,jsonb_build_object('document_no',btrim(p_document_no),'supplier_id',p_supplier_id,'supplier_name',v_supplier_name,'location_id',p_location_id,'item_count',v_line,'total_cost',v_total));
  return jsonb_build_object('id',v_receipt_id,'document_no',btrim(p_document_no),'supplier_name',v_supplier_name,'status','RECEIVED','item_count',v_line,'total_cost',v_total,'occurred_at',now(),'duplicate',false);
end $$;

create or replace function public.receive_approved_restock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_item jsonb;v_result jsonb;v_receipt_items jsonb:='[]'::jsonb;
  v_product_id uuid;v_key text;v_prices jsonb;v_price jsonb;v_new_product jsonb;v_purchase_order_id uuid;
begin
  if not public.profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak menerima barang';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status='RECEIVED' then return jsonb_build_object('id',v_request.receipt_id,'document_no',v_request.document_no,'status','RECEIVED','duplicate',true);end if;
  if v_request.status<>'APPROVED' then raise exception 'Persetujuan Owner belum tersedia';end if;
  v_purchase_order_id:=nullif(v_request.items_json->0->>'purchaseOrderId','')::uuid;
  if v_purchase_order_id is not null and not exists(
    select 1 from purchase_orders where tenant_id=p_tenant_id and id=v_purchase_order_id
      and supplier_id=v_request.supplier_id and location_id=v_request.location_id
      and status in('APPROVED','PARTIALLY_RECEIVED')
  ) then raise exception 'Purchase Order tidak lagi siap diterima';end if;
  for v_item in select value from jsonb_array_elements(v_request.items_json) loop
    if nullif(v_item->>'purchaseOrderId','')::uuid is distinct from v_purchase_order_id then raise exception 'Referensi Purchase Order tidak konsisten';end if;
    v_product_id:=nullif(v_item->>'productId','')::uuid;v_key:=coalesce(nullif(v_item->>'productKey',''),v_product_id::text);
    if v_product_id is null then
      if v_purchase_order_id is not null then raise exception 'Barang baru tidak dapat ditambahkan ke Purchase Order yang sudah disetujui';end if;
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
  if v_purchase_order_id is null then
    v_result:=public.receive_purchase(p_tenant_id,p_actor_id,p_idempotency_key,v_request.supplier_id,v_request.location_id,v_request.document_no,v_receipt_items);
  else
    v_result:=public.receive_purchase_order(p_tenant_id,p_actor_id,v_purchase_order_id,p_idempotency_key,v_request.document_no,v_receipt_items);
  end if;
  update restock_approval_requests set status='RECEIVED',receipt_id=(v_result->>'id')::uuid,received_at=now(),updated_at=now() where id=p_request_id;
  return v_result||jsonb_build_object('approvalId',p_request_id);
end $$;

revoke all on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.profile_can_receive_purchase_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.submit_restock_approval_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.profile_can_receive_purchase_v1(uuid,uuid) to service_role;
grant execute on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.submit_restock_approval_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) to service_role;
grant execute on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) to service_role;

commit;
