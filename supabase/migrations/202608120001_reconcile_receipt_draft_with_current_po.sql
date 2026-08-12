-- Reject stale PO receipt drafts before they can post stock. The browser may
-- preserve checked values, but the database remains authoritative for the
-- products and quantities that are still outstanding.

begin;

create or replace function public.assert_purchase_receipt_snapshot_current_v1(
  p_tenant_id uuid,
  p_order_id uuid,
  p_items jsonb,
  p_inspection jsonb,
  p_allow_overage boolean default false
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_order public.purchase_orders%rowtype;
  v_order_line record;
  v_snapshot_line jsonb;
  v_item jsonb;
  v_product_id uuid;
  v_actual numeric;
  v_remaining numeric;
  v_server_remaining numeric:=0;
  v_matches integer;
begin
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Tambahkan minimal satu barang yang diterima';
  end if;
  if jsonb_typeof(coalesce(p_inspection,'{}'::jsonb))<>'object'
    or jsonb_typeof(p_inspection->'lines')<>'array' then
    raise exception 'Snapshot pemeriksaan PO tidak lengkap';
  end if;
  begin
    if nullif(p_inspection->>'purchaseOrderId','')::uuid is distinct from p_order_id then
      raise exception 'Snapshot pemeriksaan tidak sesuai dengan Purchase Order';
    end if;
  exception when invalid_text_representation then
    raise exception 'Referensi Purchase Order pada pemeriksaan tidak valid';
  end;

  select * into v_order from public.purchase_orders
    where tenant_id=p_tenant_id and id=p_order_id for update;
  if not found or v_order.status not in ('APPROVED','PARTIALLY_RECEIVED') then
    raise exception 'Purchase Order tidak lagi siap diterima';
  end if;

  for v_order_line in
    select product_id,greatest(0,ordered_qty-received_qty) remaining_qty
    from public.purchase_order_items
    where tenant_id=p_tenant_id and order_id=p_order_id
    for update
  loop
    if v_order_line.remaining_qty<=0 then continue; end if;
    v_server_remaining:=v_server_remaining+v_order_line.remaining_qty;
    select count(*) into v_matches
    from jsonb_array_elements(p_inspection->'lines')
    where value->>'productId'=v_order_line.product_id::text
      and coalesce((value->>'poLine')::boolean,false)=true;
    if v_matches<>1 then
      raise exception 'Draft sudah tidak sesuai dengan sisa PO terbaru. Muat ulang pemeriksaan.';
    end if;
    select value into v_snapshot_line
    from jsonb_array_elements(p_inspection->'lines')
    where value->>'productId'=v_order_line.product_id::text
      and coalesce((value->>'poLine')::boolean,false)=true;
    if coalesce(v_snapshot_line->>'verificationMethod','') not in ('scan','manual') then
      raise exception 'Masih ada barang sisa PO yang belum diverifikasi';
    end if;
    begin
      v_actual:=(v_snapshot_line->>'baseQty')::numeric;
      if abs((v_snapshot_line->>'poRemainingBaseQty')::numeric-v_order_line.remaining_qty)>0.000001 then
        raise exception 'stale';
      end if;
    exception when others then
      raise exception 'Draft memakai jumlah sisa PO lama. Muat ulang pemeriksaan.';
    end;
    if v_actual<0 or (not p_allow_overage and v_actual>v_order_line.remaining_qty) then
      raise exception 'Jumlah hasil pemeriksaan melebihi sisa Purchase Order terbaru';
    end if;
  end loop;

  begin
    if abs(coalesce((p_inspection->'summary'->>'orderedRemainingBaseQty')::numeric,-1)-v_server_remaining)>0.000001 then
      raise exception 'stale';
    end if;
  exception when others then
    raise exception 'Ringkasan pemeriksaan memakai sisa PO lama. Muat ulang pemeriksaan.';
  end;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_actual:=(v_item->>'baseQty')::numeric;
      v_product_id:=nullif(v_item->>'productId','')::uuid;
    exception when others then
      raise exception 'Barang penerimaan tidak valid';
    end;
    if v_actual<=0 then raise exception 'Jumlah barang penerimaan tidak valid'; end if;
    if v_product_id is null then
      if not p_allow_overage then raise exception 'Barang tidak terdapat dalam Purchase Order'; end if;
      continue;
    end if;
    select greatest(0,ordered_qty-received_qty) into v_remaining
    from public.purchase_order_items
    where tenant_id=p_tenant_id and order_id=p_order_id and product_id=v_product_id
    for update;
    if not found then
      if not p_allow_overage then raise exception 'Barang tidak terdapat dalam Purchase Order'; end if;
    elsif v_remaining<=0 then
      raise exception 'Barang ini sudah diterima penuh dan tidak boleh dimasukkan kembali';
    elsif not p_allow_overage and v_actual>v_remaining then
      raise exception 'Jumlah barang melebihi sisa Purchase Order terbaru';
    end if;
    select count(*) into v_matches
    from jsonb_array_elements(p_inspection->'lines')
    where value->>'productId'=v_product_id::text
      and abs((value->>'baseQty')::numeric-v_actual)<0.000001;
    if v_matches<>1 then
      raise exception 'Barang yang akan masuk stok tidak sama dengan pemeriksaan terbaru';
    end if;
  end loop;
  return true;
end $$;

create or replace function public.submit_restock_approval_v4(
  p_tenant_id uuid,p_actor_id uuid,p_supplier_id uuid,p_location_id uuid,
  p_document_no text,p_items jsonb,p_proposed_prices jsonb,p_note text default '',
  p_inspection jsonb default '{}'::jsonb,p_draft_token uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;
begin
  begin v_order_id:=nullif(p_inspection->>'purchaseOrderId','')::uuid;
  exception when others then raise exception 'Referensi Purchase Order pada pemeriksaan tidak valid'; end;
  if v_order_id is not null then
    perform public.assert_purchase_receipt_snapshot_current_v1(
      p_tenant_id,v_order_id,p_items,p_inspection,true
    );
  end if;
  return public.submit_restock_approval_v3(
    p_tenant_id,p_actor_id,p_supplier_id,p_location_id,p_document_no,
    p_items,p_proposed_prices,p_note,p_inspection,p_draft_token
  );
end $$;

create or replace function public.receive_purchase_order_draft_v2(
  p_tenant_id uuid,p_actor_id uuid,p_order_id uuid,p_client_token uuid,
  p_document_no text,p_items jsonb,p_inspection jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  perform public.assert_purchase_receipt_snapshot_current_v1(
    p_tenant_id,p_order_id,p_items,p_inspection,false
  );
  return public.receive_purchase_order_draft_v1(
    p_tenant_id,p_actor_id,p_order_id,p_client_token,p_document_no,p_items,p_inspection
  );
end $$;

create or replace function public.receive_approved_restock_v3(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request public.restock_approval_requests%rowtype;
begin
  select * into v_request from public.restock_approval_requests
    where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan'; end if;
  if v_request.status='RECEIVED' then
    return public.receive_approved_restock_v2(p_tenant_id,p_actor_id,p_request_id);
  end if;
  if v_request.source_purchase_order_id is not null then
    perform public.assert_purchase_receipt_snapshot_current_v1(
      p_tenant_id,v_request.source_purchase_order_id,v_request.items_json,
      v_request.inspection_json,true
    );
  end if;
  return public.receive_approved_restock_v2(p_tenant_id,p_actor_id,p_request_id);
end $$;

revoke all on function public.assert_purchase_receipt_snapshot_current_v1(uuid,uuid,jsonb,jsonb,boolean)
  from public,anon,authenticated;
revoke all on function public.submit_restock_approval_v4(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,uuid)
  from public,anon,authenticated;
revoke all on function public.receive_purchase_order_draft_v2(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
revoke all on function public.receive_approved_restock_v3(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.assert_purchase_receipt_snapshot_current_v1(uuid,uuid,jsonb,jsonb,boolean)
  to service_role;
grant execute on function public.submit_restock_approval_v4(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,uuid)
  to service_role;
grant execute on function public.receive_purchase_order_draft_v2(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  to service_role;
grant execute on function public.receive_approved_restock_v3(uuid,uuid,uuid)
  to service_role;

commit;
