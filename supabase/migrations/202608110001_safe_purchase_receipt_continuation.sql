-- Preserve the complete PO inspection across Owner approval and make both
-- normal and approved receipts server-idempotent. This migration does not
-- rewrite historical receipts, purchase quantities, stock balances, or ledger.

begin;

alter table public.restock_approval_requests
  add column if not exists inspection_json jsonb not null default '{}'::jsonb,
  add column if not exists source_purchase_order_id uuid
    references public.purchase_orders(id) on delete set null;

do $$
begin
  if not exists(
    select 1 from pg_constraint
    where conrelid='public.restock_approval_requests'::regclass
      and conname='restock_approval_requests_inspection_object_check'
  ) then
    alter table public.restock_approval_requests
      add constraint restock_approval_requests_inspection_object_check
      check(jsonb_typeof(inspection_json)='object');
  end if;
end $$;

create index if not exists restock_approval_requests_source_po_idx
  on public.restock_approval_requests(tenant_id,source_purchase_order_id,requested_at desc)
  where source_purchase_order_id is not null;

create or replace function public.submit_restock_approval_v3(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_supplier_id uuid,
  p_location_id uuid,
  p_document_no text,
  p_items jsonb,
  p_proposed_prices jsonb,
  p_note text default '',
  p_inspection jsonb default '{}'::jsonb,
  p_draft_token uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;
  v_request_id uuid;
  v_purchase_order_id uuid;
  v_items_purchase_order_id uuid;
  v_draft public.purchase_receipt_drafts%rowtype;
  v_order_line record;
  v_snapshot_line jsonb;
  v_item jsonb;
  v_actual numeric;
  v_matches integer;
begin
  if jsonb_typeof(coalesce(p_inspection,'{}'::jsonb))<>'object' then
    raise exception 'Snapshot pemeriksaan tidak valid';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Tambahkan minimal satu barang yang diterima';
  end if;

  begin
    v_purchase_order_id:=nullif(p_inspection->>'purchaseOrderId','')::uuid;
    v_items_purchase_order_id:=nullif(p_items->0->>'purchaseOrderId','')::uuid;
  exception when others then
    raise exception 'Referensi Purchase Order pada pemeriksaan tidak valid';
  end;
  if v_purchase_order_id is distinct from v_items_purchase_order_id then
    raise exception 'Snapshot pemeriksaan tidak sesuai dengan Purchase Order';
  end if;

  if v_purchase_order_id is not null then
    if jsonb_typeof(p_inspection->'lines')<>'array' then
      raise exception 'Daftar pemeriksaan PO tidak lengkap';
    end if;
    select * into v_draft from public.purchase_receipt_drafts
      where tenant_id=p_tenant_id and purchase_order_id=v_purchase_order_id
        and claimed_by=p_actor_id and claim_token=p_draft_token
        and claim_expires_at>now()
      for update;
    if not found then
      raise exception 'Pemeriksaan PO tidak lagi aktif untuk akun ini. Buka kembali dari Pesanan supplier.';
    end if;

    -- Every still-outstanding PO line must have an explicit scan/manual
    -- decision. Quantity zero is retained in the snapshot but never posted.
    for v_order_line in
      select product_id,greatest(0,ordered_qty-received_qty) remaining_qty
      from public.purchase_order_items
      where tenant_id=p_tenant_id and order_id=v_purchase_order_id
        and received_qty<ordered_qty
      for update
    loop
      select value into v_snapshot_line
      from jsonb_array_elements(p_inspection->'lines')
      where value->>'productId'=v_order_line.product_id::text
        and coalesce((value->>'poLine')::boolean,false)=true
      limit 1;
      if not found then
        raise exception 'Masih ada barang sisa PO yang belum tercatat dalam pemeriksaan';
      end if;
      if coalesce(v_snapshot_line->>'verificationMethod','') not in ('scan','manual') then
        raise exception 'Masih ada barang sisa PO yang belum diverifikasi';
      end if;
      begin
        v_actual:=(v_snapshot_line->>'baseQty')::numeric;
      exception when others then
        raise exception 'Jumlah hasil pemeriksaan tidak valid';
      end;
      if v_actual<0 then raise exception 'Jumlah hasil pemeriksaan tidak valid'; end if;

      select count(*) into v_matches
      from jsonb_array_elements(p_items)
      where value->>'productId'=v_order_line.product_id::text
        and abs((value->>'baseQty')::numeric-v_actual)<0.000001;
      if (v_actual>0 and v_matches<>1) or (v_actual=0 and v_matches<>0) then
        raise exception 'Jumlah pengajuan tidak sama dengan hasil pemeriksaan PO';
      end if;
    end loop;

    -- Positive unplanned/supplement lines must also be present in the archived
    -- inspection so Owner never approves a payload different from the review.
    for v_item in select value from jsonb_array_elements(p_items) loop
      if nullif(v_item->>'purchaseOrderId','')::uuid is distinct from v_purchase_order_id then
        raise exception 'Referensi Purchase Order tidak konsisten';
      end if;
      select count(*) into v_matches
      from jsonb_array_elements(p_inspection->'lines')
      where value->>'productKey'=v_item->>'productKey'
        and abs((value->>'baseQty')::numeric-(v_item->>'baseQty')::numeric)<0.000001;
      if v_matches<>1 then
        raise exception 'Barang pengajuan tidak sama dengan snapshot pemeriksaan';
      end if;
    end loop;
  end if;

  v_result:=public.submit_restock_approval_v2(
    p_tenant_id,p_actor_id,p_supplier_id,p_location_id,p_document_no,
    p_items,p_proposed_prices,p_note
  );
  v_request_id:=(v_result->>'id')::uuid;
  update public.restock_approval_requests set
    inspection_json=coalesce(p_inspection,'{}'::jsonb),
    source_purchase_order_id=v_purchase_order_id,
    updated_at=now()
  where tenant_id=p_tenant_id and id=v_request_id;

  if v_purchase_order_id is not null then
    delete from public.purchase_receipt_drafts where id=v_draft.id;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_RECEIPT_INSPECTION_ARCHIVED','restock_approval',v_request_id,
    jsonb_build_object(
      'purchaseOrderId',v_purchase_order_id,
      'documentNo',trim(p_document_no),
      'summary',coalesce(p_inspection->'summary','{}'::jsonb)
    ));
  return v_result;
end $$;

-- Post a normal PO receipt and consume its draft in one database transaction.
-- A draft UUID is unique for a single receiving attempt and becomes its stable
-- idempotency key; a retry or second device cannot add stock twice.
create or replace function public.receive_purchase_order_draft_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_order_id uuid,
  p_client_token uuid,
  p_document_no text,
  p_items jsonb,
  p_inspection jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_draft public.purchase_receipt_drafts%rowtype;
  v_result jsonb;
  v_order_line record;
  v_snapshot_line jsonb;
  v_actual numeric;
  v_matches integer;
begin
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then
    raise exception 'Akun tidak memiliki izin menerima barang';
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
  select * into v_draft from public.purchase_receipt_drafts
    where tenant_id=p_tenant_id and purchase_order_id=p_order_id
      and claimed_by=p_actor_id and claim_token=p_client_token
      and claim_expires_at>now()
    for update;
  if not found then
    raise exception 'Pemeriksaan PO belum aktif atau telah dipindahkan ke perangkat lain';
  end if;

  -- Refuse the receipt unless every currently outstanding PO product has one
  -- explicit scan/manual result and the positive posting matches it exactly.
  for v_order_line in
    select product_id,greatest(0,ordered_qty-received_qty) remaining_qty
    from public.purchase_order_items
    where tenant_id=p_tenant_id and order_id=p_order_id
      and received_qty<ordered_qty
    for update
  loop
    select count(*) into v_matches
    from jsonb_array_elements(p_inspection->'lines')
    where value->>'productId'=v_order_line.product_id::text
      and coalesce((value->>'poLine')::boolean,false)=true;
    if v_matches<>1 then
      raise exception 'Setiap barang sisa PO harus memiliki tepat satu hasil pemeriksaan';
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
    exception when others then
      raise exception 'Jumlah hasil pemeriksaan tidak valid';
    end;
    if v_actual<0 or v_actual>v_order_line.remaining_qty then
      raise exception 'Jumlah hasil pemeriksaan melebihi sisa Purchase Order';
    end if;
    select count(*) into v_matches
    from jsonb_array_elements(p_items)
    where value->>'productId'=v_order_line.product_id::text
      and abs((value->>'baseQty')::numeric-v_actual)<0.000001;
    if (v_actual>0 and v_matches<>1) or (v_actual=0 and v_matches<>0) then
      raise exception 'Barang yang akan masuk stok tidak sama dengan hasil pemeriksaan';
    end if;
  end loop;

  v_result:=public.receive_purchase_order(
    p_tenant_id,p_actor_id,p_order_id,
    'PO-RECEIPT-DRAFT:'||v_draft.id::text,p_document_no,p_items
  );
  delete from public.purchase_receipt_drafts where id=v_draft.id;
  return v_result;
end $$;

-- Approved receipts use the approval UUID itself as the stable key. The v1
-- function already locks the request row and returns its existing receipt once
-- completed; this wrapper removes client-generated keys from stock identity.
create or replace function public.receive_approved_restock_v2(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  return public.receive_approved_restock_v1(
    p_tenant_id,p_actor_id,p_request_id,
    'RESTOCK-APPROVAL:'||p_request_id::text
  );
end $$;

create or replace function public.resubmit_restock_approval_v2(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_items jsonb,
  p_note text default '',p_inspection jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;v_item jsonb;v_matches integer;
begin
  if jsonb_typeof(coalesce(p_inspection,'{}'::jsonb))<>'object' then
    raise exception 'Snapshot pemeriksaan revisi tidak valid';
  end if;
  if p_inspection<>'{}'::jsonb then
    if jsonb_typeof(p_inspection->'lines')<>'array' then
      raise exception 'Daftar pemeriksaan revisi tidak lengkap';
    end if;
    for v_item in select value from jsonb_array_elements(p_items) loop
      select count(*) into v_matches from jsonb_array_elements(p_inspection->'lines')
      where value->>'productKey'=coalesce(v_item->>'productKey',v_item->>'productId')
        and abs((value->>'baseQty')::numeric-(v_item->>'baseQty')::numeric)<0.000001;
      if v_matches<>1 then
        raise exception 'Jumlah revisi tidak sama dengan snapshot pemeriksaan';
      end if;
    end loop;
  end if;
  v_result:=public.resubmit_restock_approval_v1(
    p_tenant_id,p_actor_id,p_request_id,p_items,p_note
  );
  if p_inspection<>'{}'::jsonb then
    update public.restock_approval_requests set inspection_json=p_inspection,updated_at=now()
      where tenant_id=p_tenant_id and id=p_request_id;
  end if;
  return v_result;
end $$;

revoke all on function public.submit_restock_approval_v3(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,uuid)
  from public,anon,authenticated;
revoke all on function public.receive_purchase_order_draft_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
revoke all on function public.receive_approved_restock_v2(uuid,uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.resubmit_restock_approval_v2(uuid,uuid,uuid,jsonb,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.submit_restock_approval_v3(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,jsonb,uuid)
  to service_role;
grant execute on function public.receive_purchase_order_draft_v1(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  to service_role;
grant execute on function public.receive_approved_restock_v2(uuid,uuid,uuid)
  to service_role;
grant execute on function public.resubmit_restock_approval_v2(uuid,uuid,uuid,jsonb,text,jsonb)
  to service_role;

commit;
