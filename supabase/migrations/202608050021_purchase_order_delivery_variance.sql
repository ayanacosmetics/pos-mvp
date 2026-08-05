-- Allow an Owner-approved receipt to record supplier over-delivery without rewriting the original PO quantity.
begin;

alter table public.purchase_order_items
  add column if not exists is_supplement boolean not null default false,
  add column if not exists supplement_approval_id uuid references public.restock_approval_requests(id) on delete set null;

-- The original constraint made an approved over-delivery impossible to record. The normal
-- receive_purchase_order function still enforces the PO remainder; only the approval path below may exceed it.
do $$
declare v_constraint record;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid='public.purchase_order_items'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) ilike '%received_qty%ordered_qty%'
  loop
    execute format('alter table public.purchase_order_items drop constraint %I',v_constraint.conname);
  end loop;
end $$;

create or replace function public.submit_restock_approval_v2(
  p_tenant_id uuid,p_actor_id uuid,p_supplier_id uuid,p_location_id uuid,
  p_document_no text,p_items jsonb,p_proposed_prices jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_id uuid;v_item jsonb;v_items jsonb:='[]'::jsonb;v_product uuid;v_new_cost numeric;v_last_cost numeric;
  v_requires boolean:=false;v_purchase_order_id uuid;v_item_po uuid;v_po purchase_orders%rowtype;
  v_ordered numeric;v_received numeric;v_actual numeric;v_excess numeric;v_line_found boolean;
begin
  if not profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak mengajukan penerimaan';end if;
  if not exists(select 1 from suppliers where tenant_id=p_tenant_id and id=p_supplier_id and active) then raise exception 'Supplier tidak valid';end if;
  if not exists(select 1 from stock_locations where tenant_id=p_tenant_id and id=p_location_id and active) then raise exception 'Lokasi tidak valid';end if;
  if nullif(trim(p_document_no),'') is null then raise exception 'Nomor faktur wajib diisi';end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan minimal satu barang';end if;
  if jsonb_typeof(p_proposed_prices)<>'array' then raise exception 'Usulan harga tidak valid';end if;

  v_purchase_order_id:=nullif(p_items->0->>'purchaseOrderId','')::uuid;
  if v_purchase_order_id is not null then
    select * into v_po from purchase_orders where tenant_id=p_tenant_id and id=v_purchase_order_id
      and supplier_id=p_supplier_id and location_id=p_location_id and status in('APPROVED','PARTIALLY_RECEIVED');
    if not found then raise exception 'Purchase Order tidak lagi siap diterima';end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_item_po:=nullif(v_item->>'purchaseOrderId','')::uuid;
    if v_item_po is distinct from v_purchase_order_id then raise exception 'Referensi Purchase Order tidak konsisten';end if;
    v_actual:=coalesce((v_item->>'baseQty')::numeric,0);
    v_new_cost:=coalesce((v_item->>'unitCost')::numeric,-1);
    if v_actual<=0 or v_new_cost<0 then raise exception 'Jumlah atau modal tidak valid';end if;
    v_product:=nullif(v_item->>'productId','')::uuid;
    if v_product is null then
      if jsonb_typeof(v_item->'newProduct')<>'object' then raise exception 'Data barang baru tidak lengkap';end if;
      v_requires:=true;
    else
      if not exists(select 1 from products where tenant_id=p_tenant_id and id=v_product and active) then raise exception 'Produk tidak valid';end if;
      select unit_cost into v_last_cost from purchase_receipt_items where tenant_id=p_tenant_id and product_id=v_product order by received_at desc,id desc limit 1;
      if v_last_cost is null or v_last_cost is distinct from v_new_cost then v_requires:=true;end if;
    end if;

    if v_purchase_order_id is not null then
      select ordered_qty,received_qty into v_ordered,v_received from purchase_order_items
        where order_id=v_purchase_order_id and product_id=v_product for update;
      v_line_found:=found;
      if not v_line_found then
        v_requires:=true;v_excess:=v_actual;
        v_item:=v_item||jsonb_build_object('poVarianceType','UNPLANNED','poOrderedBaseQty',0,'poRemainingBaseQty',0,'poExcessBaseQty',v_actual);
      else
        v_excess:=greatest(0,v_actual-greatest(0,v_ordered-v_received));
        if v_excess>0 then v_requires:=true;end if;
        v_item:=v_item||jsonb_build_object(
          'poVarianceType',case when v_excess>0 then 'OVER' else null end,
          'poOrderedBaseQty',v_ordered,'poRemainingBaseQty',greatest(0,v_ordered-v_received),'poExcessBaseQty',v_excess
        );
      end if;
    end if;
    v_items:=v_items||jsonb_build_array(v_item);
  end loop;
  if not v_requires then raise exception 'Penerimaan ini tidak memerlukan persetujuan Owner';end if;
  insert into restock_approval_requests(tenant_id,requester_id,supplier_id,location_id,document_no,items_json,proposed_prices_json,requester_note)
    values(p_tenant_id,p_actor_id,p_supplier_id,p_location_id,trim(p_document_no),v_items,p_proposed_prices,nullif(trim(p_note),'')) returning id into v_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_APPROVAL_REQUESTED','restock_approval',v_id,
      jsonb_build_object('documentNo',trim(p_document_no),'itemCount',jsonb_array_length(v_items),'purchaseOrderId',v_purchase_order_id));
  return jsonb_build_object('id',v_id,'status','PENDING');
end $$;

create or replace function public.receive_approved_restock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_request restock_approval_requests%rowtype;v_item jsonb;v_result jsonb;v_receipt_items jsonb:='[]'::jsonb;
  v_product_id uuid;v_key text;v_prices jsonb;v_price jsonb;v_new_product jsonb;v_purchase_order_id uuid;
  v_unit jsonb;v_product_name text;v_supplement_count integer:=0;v_overage_count integer:=0;v_order_item purchase_order_items%rowtype;
  v_all_received boolean;v_next text;
begin
  if not profile_can_receive_purchase_v1(p_tenant_id,p_actor_id) then raise exception 'Akun tidak memiliki hak menerima barang';end if;
  select * into v_request from restock_approval_requests where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status='RECEIVED' then return jsonb_build_object('id',v_request.receipt_id,'document_no',v_request.document_no,'status','RECEIVED','duplicate',true);end if;
  if v_request.status<>'APPROVED' then raise exception 'Persetujuan Owner belum tersedia';end if;
  v_purchase_order_id:=nullif(v_request.items_json->0->>'purchaseOrderId','')::uuid;
  if v_purchase_order_id is not null and not exists(select 1 from purchase_orders where tenant_id=p_tenant_id and id=v_purchase_order_id
    and supplier_id=v_request.supplier_id and location_id=v_request.location_id and status in('APPROVED','PARTIALLY_RECEIVED')) then
    raise exception 'Purchase Order tidak lagi siap diterima';
  end if;

  for v_item in select value from jsonb_array_elements(v_request.items_json) loop
    if nullif(v_item->>'purchaseOrderId','')::uuid is distinct from v_purchase_order_id then raise exception 'Referensi Purchase Order tidak konsisten';end if;
    v_product_id:=nullif(v_item->>'productId','')::uuid;v_key:=coalesce(nullif(v_item->>'productKey',''),v_product_id::text);
    if v_product_id is null then
      v_new_product:=v_item->'newProduct';v_result:=save_product_v6(p_tenant_id,v_request.approver_id,v_new_product);v_product_id:=(v_result->>'id')::uuid;
    end if;

    if v_purchase_order_id is not null then
      select * into v_order_item from purchase_order_items where order_id=v_purchase_order_id and product_id=v_product_id for update;
      if not found then
        select name into v_product_name from products where tenant_id=p_tenant_id and id=v_product_id;
        v_unit:=validate_purchase_unit_v1(p_tenant_id,v_product_id,v_item);
        insert into purchase_order_items(tenant_id,order_id,product_id,product_name,ordered_qty,received_qty,unit_cost,line_discount,line_total,
          purchase_unit_id,purchase_unit_name,purchase_unit_factor,ordered_purchase_qty,purchase_unit_cost,is_supplement,supplement_approval_id)
        values(p_tenant_id,v_purchase_order_id,v_product_id,v_product_name,(v_item->>'baseQty')::numeric,0,(v_item->>'unitCost')::numeric,0,
          round((v_item->>'baseQty')::numeric*(v_item->>'unitCost')::numeric,4),(v_unit->>'id')::uuid,v_unit->>'name',(v_unit->>'factor')::numeric,
          (v_unit->>'qty')::numeric,(v_unit->>'unitCost')::numeric,true,p_request_id);
        v_supplement_count:=v_supplement_count+1;
      elsif v_order_item.received_qty+(v_item->>'baseQty')::numeric>v_order_item.ordered_qty then
        v_overage_count:=v_overage_count+1;
      end if;
    end if;

    v_prices:=coalesce((select jsonb_agg(value) from jsonb_array_elements(coalesce(v_request.approved_prices_json,'[]'::jsonb)) value where value->>'productKey'=v_key),'[]'::jsonb);
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

  v_result:=receive_purchase(p_tenant_id,p_actor_id,p_idempotency_key,v_request.supplier_id,v_request.location_id,v_request.document_no,v_receipt_items);
  if not coalesce((v_result->>'duplicate')::boolean,false) and v_purchase_order_id is not null then
    update purchase_receipts set order_id=v_purchase_order_id where id=(v_result->>'id')::uuid;
    for v_item in select value from jsonb_array_elements(v_receipt_items) loop
      update purchase_order_items set received_qty=received_qty+(v_item->>'baseQty')::numeric
        where order_id=v_purchase_order_id and product_id=(v_item->>'productId')::uuid;
    end loop;
    select bool_and(received_qty>=ordered_qty) into v_all_received from purchase_order_items where order_id=v_purchase_order_id;
    v_next:=case when v_all_received then 'RECEIVED' else 'PARTIALLY_RECEIVED' end;
    update purchase_orders po set status=v_next,subtotal=totals.subtotal,
      grand_total=greatest(0,totals.subtotal-po.discount_amount+po.tax_amount+po.other_cost),updated_at=now()
    from(select coalesce(sum(line_total),0)::numeric subtotal from purchase_order_items where order_id=v_purchase_order_id) totals
    where po.id=v_purchase_order_id and po.tenant_id=p_tenant_id;
    insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
      values(p_tenant_id,v_request.approver_id,'PURCHASE_ORDER_DELIVERY_VARIANCE_APPROVED','purchase_order',v_purchase_order_id,
        jsonb_build_object('approvalId',p_request_id,'receiptId',v_result->>'id','overageItemCount',v_overage_count,'supplementItemCount',v_supplement_count));
    v_result:=v_result||jsonb_build_object('order_id',v_purchase_order_id,'po_status',v_next,'overage_item_count',v_overage_count,'supplement_item_count',v_supplement_count);
  end if;
  update restock_approval_requests set status='RECEIVED',receipt_id=(v_result->>'id')::uuid,received_at=now(),updated_at=now() where id=p_request_id;
  return v_result||jsonb_build_object('approvalId',p_request_id);
end $$;

revoke all on function public.submit_restock_approval_v2(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.submit_restock_approval_v2(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text) to service_role;
grant execute on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) to service_role;

commit;
