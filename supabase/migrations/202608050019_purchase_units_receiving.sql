-- Preserve the supplier-facing purchase unit while inventory and FIFO remain normalized to base units.
begin;

alter table public.purchase_order_items
  add column if not exists purchase_unit_id uuid,
  add column if not exists purchase_unit_name text,
  add column if not exists purchase_unit_factor numeric(19,6),
  add column if not exists ordered_purchase_qty numeric(19,6),
  add column if not exists purchase_unit_cost numeric(19,4);

alter table public.purchase_receipt_items
  add column if not exists purchase_unit_id uuid,
  add column if not exists purchase_unit_name text,
  add column if not exists purchase_unit_factor numeric(19,6),
  add column if not exists received_purchase_qty numeric(19,6),
  add column if not exists purchase_unit_cost numeric(19,4);

create or replace function public.validate_purchase_unit_v1(p_tenant_id uuid,p_product_id uuid,p_item jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_id uuid:=nullif(p_item->>'purchaseUnitId','')::uuid;v_name text:=nullif(trim(p_item->>'purchaseUnitName'),'');
  v_factor numeric:=coalesce(nullif(p_item->>'purchaseUnitFactor','')::numeric,1);
  v_qty numeric:=coalesce(nullif(p_item->>'purchaseQty','')::numeric,(p_item->>'baseQty')::numeric/v_factor);
  v_unit_cost numeric:=coalesce(nullif(p_item->>'purchaseUnitCost','')::numeric,(p_item->>'unitCost')::numeric*v_factor);
  v_base_qty numeric:=(p_item->>'baseQty')::numeric;v_base_cost numeric:=(p_item->>'unitCost')::numeric;v_unit product_units%rowtype;
begin
  if v_factor<=0 or v_qty<=0 or v_unit_cost<0 then raise exception 'Satuan, jumlah, atau modal pembelian tidak valid';end if;
  if abs(v_base_qty-(v_qty*v_factor))>0.000001 then raise exception 'Konversi jumlah pembelian tidak konsisten';end if;
  if abs(v_base_cost-(v_unit_cost/v_factor))>0.0001 then raise exception 'Konversi modal pembelian tidak konsisten';end if;
  if v_id is not null then
    select * into v_unit from product_units where tenant_id=p_tenant_id and product_id=p_product_id and id=v_id;
  elsif v_name is not null then
    select * into v_unit from product_units where tenant_id=p_tenant_id and product_id=p_product_id and lower(name)=lower(v_name) and abs(factor_to_base-v_factor)<=0.000001 limit 1;
  else
    select * into v_unit from product_units where tenant_id=p_tenant_id and product_id=p_product_id and abs(factor_to_base-v_factor)<=0.000001 order by factor_to_base limit 1;
  end if;
  if not found or abs(v_unit.factor_to_base-v_factor)>0.000001 then raise exception 'Satuan pembelian tidak cocok dengan produk';end if;
  return jsonb_build_object('id',v_unit.id,'name',v_unit.name,'factor',v_factor,'qty',v_qty,'unitCost',v_unit_cost);
end $$;

create or replace function public.save_purchase_order(
  p_tenant_id uuid,p_actor_id uuid,p_order_id uuid,p_supplier_id uuid,p_location_id uuid,p_expected_on date,
  p_notes text,p_discount_amount numeric,p_tax_amount numeric,p_other_cost numeric,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;v_po_no text;v_supplier_name text;v_sequence bigint;v_item jsonb;v_unit jsonb;
  v_product_id uuid;v_product_name text;v_qty numeric;v_cost numeric;v_line_discount numeric;v_line_total numeric;
  v_subtotal numeric:=0;v_grand_total numeric;v_count integer:=0;
begin
  if not exists(select 1 from profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active and role in('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak memiliki hak membuat Purchase Order';end if;
  select name into v_supplier_name from suppliers where id=p_supplier_id and tenant_id=p_tenant_id and active;
  if v_supplier_name is null then raise exception 'Supplier tidak valid';end if;
  if not exists(select 1 from stock_locations where id=p_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi tujuan tidak valid';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan minimal satu barang ke Purchase Order';end if;
  if coalesce(p_discount_amount,0)<0 or coalesce(p_tax_amount,0)<0 or coalesce(p_other_cost,0)<0 then raise exception 'Diskon, pajak, dan biaya tambahan tidak boleh negatif';end if;
  if p_order_id is null then
    insert into document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'PURCHASE_ORDER',2)
      on conflict(tenant_id,kind) do update set next_value=document_sequences.next_value+1 returning next_value-1 into v_sequence;
    v_po_no:='PO-'||to_char(now(),'YYMM')||'-'||lpad(v_sequence::text,5,'0');
    insert into purchase_orders(tenant_id,po_no,supplier_id,supplier_name,location_id,expected_on,notes,status,created_by)
      values(p_tenant_id,v_po_no,p_supplier_id,v_supplier_name,p_location_id,p_expected_on,nullif(btrim(p_notes),''),'DRAFT',p_actor_id) returning id into v_order_id;
  else
    select id,po_no into v_order_id,v_po_no from purchase_orders where id=p_order_id and tenant_id=p_tenant_id and status='DRAFT' for update;
    if v_order_id is null then raise exception 'Hanya Purchase Order berstatus Draft yang dapat diubah';end if;
    update purchase_orders set supplier_id=p_supplier_id,supplier_name=v_supplier_name,location_id=p_location_id,expected_on=p_expected_on,notes=nullif(btrim(p_notes),''),updated_at=now() where id=v_order_id;
    delete from purchase_order_items where order_id=v_order_id;
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product_id:=nullif(v_item->>'productId','')::uuid;v_qty:=(v_item->>'baseQty')::numeric;v_cost:=(v_item->>'unitCost')::numeric;
    v_line_discount:=coalesce(nullif(v_item->>'lineDiscount','')::numeric,0);
    select name into v_product_name from products where id=v_product_id and tenant_id=p_tenant_id and active;
    if v_product_name is null then raise exception 'Produk pada baris % tidak valid',v_count+1;end if;
    if v_qty<=0 or v_cost<0 then raise exception 'Jumlah atau modal pesanan tidak valid';end if;
    v_unit:=validate_purchase_unit_v1(p_tenant_id,v_product_id,v_item);
    v_line_total:=greatest(0,(v_qty*v_cost)-v_line_discount);
    insert into purchase_order_items(tenant_id,order_id,product_id,product_name,ordered_qty,received_qty,unit_cost,line_discount,line_total,purchase_unit_id,purchase_unit_name,purchase_unit_factor,ordered_purchase_qty,purchase_unit_cost)
      values(p_tenant_id,v_order_id,v_product_id,v_product_name,v_qty,0,v_cost,v_line_discount,v_line_total,(v_unit->>'id')::uuid,v_unit->>'name',(v_unit->>'factor')::numeric,(v_unit->>'qty')::numeric,(v_unit->>'unitCost')::numeric);
    v_subtotal:=v_subtotal+v_line_total;v_count:=v_count+1;
  end loop;
  v_grand_total:=greatest(0,v_subtotal-coalesce(p_discount_amount,0)+coalesce(p_tax_amount,0)+coalesce(p_other_cost,0));
  update purchase_orders set subtotal=v_subtotal,discount_amount=coalesce(p_discount_amount,0),tax_amount=coalesce(p_tax_amount,0),other_cost=coalesce(p_other_cost,0),grand_total=v_grand_total,updated_at=now() where id=v_order_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,'PURCHASE_ORDER_DRAFT_SAVED','purchase_order',v_order_id,jsonb_build_object('po_no',v_po_no,'supplier_name',v_supplier_name,'item_count',v_count,'grand_total',v_grand_total));
  return jsonb_build_object('id',v_order_id,'po_no',v_po_no,'status','DRAFT','item_count',v_count,'grand_total',v_grand_total);
end $$;

create or replace function public.receive_purchase(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_supplier_id uuid,p_location_id uuid,p_document_no text,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_receipt_id uuid;v_existing purchase_receipts%rowtype;v_supplier_name text;v_item jsonb;v_unit jsonb;v_product_id uuid;
  v_qty numeric;v_cost numeric;v_batch text;v_expires date;v_balance_qty numeric;v_balance_cost numeric;v_new_qty numeric;v_new_avg numeric;v_line integer:=0;v_total numeric:=0;
begin
  if not profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak menerima pembelian';end if;
  select name into v_supplier_name from suppliers where id=p_supplier_id and tenant_id=p_tenant_id and active;
  if v_supplier_name is null then raise exception 'Supplier tidak valid';end if;
  if not exists(select 1 from stock_locations where id=p_location_id and tenant_id=p_tenant_id) then raise exception 'Lokasi penerimaan tidak valid';end if;
  if nullif(btrim(p_document_no),'') is null or nullif(btrim(p_idempotency_key),'') is null then raise exception 'Nomor dokumen dan idempotency key wajib diisi';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan minimal satu barang restok';end if;
  select * into v_existing from purchase_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'document_no',v_existing.document_no,'status',v_existing.status,'duplicate',true);end if;
  insert into purchase_receipts(tenant_id,supplier_id,supplier_name,location_id,document_no,idempotency_key,actor_id,status)
    values(p_tenant_id,p_supplier_id,v_supplier_name,p_location_id,btrim(p_document_no),p_idempotency_key,p_actor_id,'RECEIVED')
    on conflict(tenant_id,idempotency_key) do nothing returning id into v_receipt_id;
  if v_receipt_id is null then
    select * into v_existing from purchase_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
    return jsonb_build_object('id',v_existing.id,'document_no',v_existing.document_no,'status',v_existing.status,'duplicate',true);
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line:=v_line+1;v_product_id:=nullif(v_item->>'productId','')::uuid;v_qty:=(v_item->>'baseQty')::numeric;v_cost:=(v_item->>'unitCost')::numeric;
    v_batch:=nullif(btrim(v_item->>'batchNo'),'');v_expires:=nullif(v_item->>'expiresOn','')::date;
    if not exists(select 1 from products where id=v_product_id and tenant_id=p_tenant_id and active) then raise exception 'Produk pada baris % tidak valid',v_line;end if;
    if v_qty<=0 or v_cost<0 then raise exception 'Jumlah atau modal pada baris % tidak valid',v_line;end if;
    v_unit:=validate_purchase_unit_v1(p_tenant_id,v_product_id,v_item);
    insert into purchase_receipt_items(tenant_id,receipt_id,product_id,base_qty,unit_cost,batch_no,expires_on,supplier_id,supplier_name,document_no,received_at,purchase_unit_id,purchase_unit_name,purchase_unit_factor,received_purchase_qty,purchase_unit_cost)
      values(p_tenant_id,v_receipt_id,v_product_id,v_qty,v_cost,v_batch,v_expires,p_supplier_id,v_supplier_name,btrim(p_document_no),now(),(v_unit->>'id')::uuid,v_unit->>'name',(v_unit->>'factor')::numeric,(v_unit->>'qty')::numeric,(v_unit->>'unitCost')::numeric);
    insert into stock_balances(tenant_id,location_id,product_id) values(p_tenant_id,p_location_id,v_product_id) on conflict(location_id,product_id) do nothing;
    select quantity,avg_cost into v_balance_qty,v_balance_cost from stock_balances where location_id=p_location_id and product_id=v_product_id for update;
    v_new_qty:=v_balance_qty+v_qty;v_new_avg:=case when v_balance_qty<=0 then v_cost else round(((v_balance_qty*v_balance_cost)+(v_qty*v_cost))/v_new_qty,4) end;
    update stock_balances set quantity=v_new_qty,avg_cost=v_new_avg,version=version+1,updated_at=now() where location_id=p_location_id and product_id=v_product_id;
    insert into stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
      values(p_tenant_id,p_location_id,v_product_id,v_qty,v_new_qty,v_cost,'PURCHASE_RECEIPT',v_receipt_id,concat_ws(' · ',btrim(p_document_no),(v_unit->>'qty')||' '||(v_unit->>'name'),case when v_batch is not null then 'batch '||v_batch end),p_actor_id,p_idempotency_key||':stock:'||v_line);
    v_total:=v_total+(v_qty*v_cost);
  end loop;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,'PURCHASE_RECEIVED','purchase_receipt',v_receipt_id,jsonb_build_object('document_no',btrim(p_document_no),'supplier_id',p_supplier_id,'location_id',p_location_id,'item_count',v_line,'total_cost',v_total));
  return jsonb_build_object('id',v_receipt_id,'document_no',btrim(p_document_no),'supplier_name',v_supplier_name,'status','RECEIVED','item_count',v_line,'total_cost',v_total,'occurred_at',now(),'duplicate',false);
end $$;

revoke all on function public.validate_purchase_unit_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_purchase_order(uuid,uuid,uuid,uuid,uuid,date,text,numeric,numeric,numeric,jsonb) from public,anon,authenticated;
revoke all on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.validate_purchase_unit_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.save_purchase_order(uuid,uuid,uuid,uuid,uuid,date,text,numeric,numeric,numeric,jsonb) to service_role;
grant execute on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;

create or replace function public.receive_approved_restock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request restock_approval_requests%rowtype;v_item jsonb;v_result jsonb;v_receipt_items jsonb:='[]'::jsonb;
  v_product_id uuid;v_key text;v_prices jsonb;v_price jsonb;v_new_product jsonb;v_purchase_order_id uuid;v_supplement_count integer:=0;v_unit jsonb;
begin
  if not profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak menerima barang';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status='RECEIVED' then return jsonb_build_object('id',v_request.receipt_id,'document_no',v_request.document_no,'status','RECEIVED','duplicate',true);end if;
  if v_request.status<>'APPROVED' then raise exception 'Persetujuan Owner belum tersedia';end if;
  v_purchase_order_id:=nullif(v_request.items_json->0->>'purchaseOrderId','')::uuid;
  if v_purchase_order_id is not null and not exists(select 1 from purchase_orders where tenant_id=p_tenant_id and id=v_purchase_order_id and supplier_id=v_request.supplier_id and location_id=v_request.location_id and status in('APPROVED','PARTIALLY_RECEIVED')) then raise exception 'Purchase Order tidak lagi siap diterima';end if;
  for v_item in select value from jsonb_array_elements(v_request.items_json) loop
    if nullif(v_item->>'purchaseOrderId','')::uuid is distinct from v_purchase_order_id then raise exception 'Referensi Purchase Order tidak konsisten';end if;
    v_product_id:=nullif(v_item->>'productId','')::uuid;v_key:=coalesce(nullif(v_item->>'productKey',''),v_product_id::text);
    if v_product_id is null then
      v_new_product:=v_item->'newProduct';v_result:=save_product_v6(p_tenant_id,v_request.approver_id,v_new_product);v_product_id:=(v_result->>'id')::uuid;
      if v_purchase_order_id is not null then
        v_unit:=validate_purchase_unit_v1(p_tenant_id,v_product_id,v_item);
        insert into purchase_order_items(tenant_id,order_id,product_id,product_name,ordered_qty,received_qty,unit_cost,line_discount,line_total,purchase_unit_id,purchase_unit_name,purchase_unit_factor,ordered_purchase_qty,purchase_unit_cost)
          values(p_tenant_id,v_purchase_order_id,v_product_id,v_new_product->>'name',(v_item->>'baseQty')::numeric,0,(v_item->>'unitCost')::numeric,0,round((v_item->>'baseQty')::numeric*(v_item->>'unitCost')::numeric,4),(v_unit->>'id')::uuid,v_unit->>'name',(v_unit->>'factor')::numeric,(v_unit->>'qty')::numeric,(v_unit->>'unitCost')::numeric);
        v_supplement_count:=v_supplement_count+1;
      end if;
    end if;
    v_prices:=coalesce((select jsonb_agg(value) from jsonb_array_elements(v_request.approved_prices_json) value where value->>'productKey'=v_key),'[]'::jsonb);
    if jsonb_array_length(v_prices)>0 then
      delete from price_rules where tenant_id=p_tenant_id and product_id=v_product_id and starts_at is null and ends_at is null;
      for v_price in select value from jsonb_array_elements(v_prices) loop
        insert into price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
          values(p_tenant_id,v_product_id,v_price->>'customerGroupId',(v_price->>'minBaseQty')::integer,(v_price->>'unitPriceBase')::numeric,10);
      end loop;
      perform refresh_safe_customer_prices_v1(p_tenant_id,v_product_id);
    end if;
    v_receipt_items:=v_receipt_items||jsonb_build_array((v_item||jsonb_build_object('productId',v_product_id))-'newProduct');
  end loop;
  if v_purchase_order_id is not null and v_supplement_count>0 then
    update purchase_orders po set subtotal=totals.subtotal,grand_total=greatest(0,totals.subtotal-po.discount_amount+po.tax_amount+po.other_cost),updated_at=now()
      from(select coalesce(sum(line_total),0)::numeric subtotal from purchase_order_items where order_id=v_purchase_order_id) totals where po.id=v_purchase_order_id and po.tenant_id=p_tenant_id;
    insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,v_request.approver_id,'PURCHASE_ORDER_SUPPLEMENT_APPROVED','purchase_order',v_purchase_order_id,jsonb_build_object('approvalId',p_request_id,'newProductCount',v_supplement_count,'documentNo',v_request.document_no));
  end if;
  if v_purchase_order_id is null then
    v_result:=receive_purchase(p_tenant_id,p_actor_id,p_idempotency_key,v_request.supplier_id,v_request.location_id,v_request.document_no,v_receipt_items);
  else
    v_result:=receive_purchase_order(p_tenant_id,p_actor_id,v_purchase_order_id,p_idempotency_key,v_request.document_no,v_receipt_items);
  end if;
  update restock_approval_requests set status='RECEIVED',receipt_id=(v_result->>'id')::uuid,received_at=now(),updated_at=now() where id=p_request_id;
  return v_result||jsonb_build_object('approvalId',p_request_id);
end $$;

revoke all on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) to service_role;

commit;
