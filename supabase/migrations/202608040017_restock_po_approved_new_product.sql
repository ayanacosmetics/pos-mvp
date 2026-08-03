-- Allow an Owner-approved new product to supplement an approved PO during receipt.
begin;

create or replace function public.receive_approved_restock_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_request restock_approval_requests%rowtype;v_item jsonb;v_result jsonb;v_receipt_items jsonb:='[]'::jsonb;
  v_product_id uuid;v_key text;v_prices jsonb;v_price jsonb;v_new_product jsonb;v_purchase_order_id uuid;
  v_supplement_count integer:=0;
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
      v_new_product:=v_item->'newProduct';
      v_result:=public.save_product_v6(p_tenant_id,v_request.approver_id,v_new_product);
      v_product_id:=(v_result->>'id')::uuid;
      if v_purchase_order_id is not null then
        insert into purchase_order_items(
          tenant_id,order_id,product_id,product_name,ordered_qty,received_qty,unit_cost,line_discount,line_total
        ) values(
          p_tenant_id,v_purchase_order_id,v_product_id,v_new_product->>'name',
          (v_item->>'baseQty')::numeric,0,(v_item->>'unitCost')::numeric,0,
          round((v_item->>'baseQty')::numeric*(v_item->>'unitCost')::numeric,4)
        );
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
      perform public.refresh_safe_customer_prices_v1(p_tenant_id,v_product_id);
    end if;
    v_receipt_items:=v_receipt_items||jsonb_build_array(jsonb_build_object(
      'productId',v_product_id,'baseQty',v_item->'baseQty','unitCost',v_item->'unitCost',
      'batchNo',v_item->'batchNo','expiresOn',v_item->'expiresOn'
    ));
  end loop;

  if v_purchase_order_id is not null and v_supplement_count>0 then
    update purchase_orders po set
      subtotal=totals.subtotal,
      grand_total=greatest(0,totals.subtotal-po.discount_amount+po.tax_amount+po.other_cost),
      updated_at=now()
    from (
      select coalesce(sum(line_total),0)::numeric(19,4) subtotal
      from purchase_order_items where order_id=v_purchase_order_id
    ) totals
    where po.id=v_purchase_order_id and po.tenant_id=p_tenant_id;
    insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,v_request.approver_id,'PURCHASE_ORDER_SUPPLEMENT_APPROVED','purchase_order',v_purchase_order_id,
      jsonb_build_object('approvalId',p_request_id,'newProductCount',v_supplement_count,'documentNo',v_request.document_no));
  end if;

  if v_purchase_order_id is null then
    v_result:=public.receive_purchase(p_tenant_id,p_actor_id,p_idempotency_key,v_request.supplier_id,v_request.location_id,v_request.document_no,v_receipt_items);
  else
    v_result:=public.receive_purchase_order(p_tenant_id,p_actor_id,v_purchase_order_id,p_idempotency_key,v_request.document_no,v_receipt_items);
  end if;
  update restock_approval_requests set status='RECEIVED',receipt_id=(v_result->>'id')::uuid,received_at=now(),updated_at=now() where id=p_request_id;
  return v_result||jsonb_build_object('approvalId',p_request_id);
end $$;

revoke all on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.receive_approved_restock_v1(uuid,uuid,uuid,text) to service_role;

commit;
