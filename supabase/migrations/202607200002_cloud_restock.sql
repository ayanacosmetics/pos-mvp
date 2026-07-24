-- Kasir Nusa POS - cloud restock transaction and supplier cost history

alter table public.purchase_receipt_items
  add column if not exists supplier_id uuid references public.suppliers(id),
  add column if not exists supplier_name text,
  add column if not exists document_no text,
  add column if not exists received_at timestamptz not null default now();

update public.purchase_receipt_items item
set supplier_id = receipt.supplier_id,
    supplier_name = receipt.supplier_name,
    document_no = receipt.document_no,
    received_at = receipt.occurred_at
from public.purchase_receipts receipt
where item.receipt_id = receipt.id
  and (item.supplier_name is null or item.document_no is null);

create index if not exists purchase_cost_history_idx
  on public.purchase_receipt_items(tenant_id, product_id, supplier_id, received_at desc);

create or replace function public.receive_purchase(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_supplier_id uuid,
  p_location_id uuid,
  p_document_no text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_id uuid;
  v_existing public.purchase_receipts%rowtype;
  v_supplier_name text;
  v_item jsonb;
  v_product_id uuid;
  v_qty numeric(19,6);
  v_cost numeric(19,4);
  v_batch text;
  v_expires date;
  v_balance_qty numeric(19,6);
  v_balance_cost numeric(19,4);
  v_new_qty numeric(19,6);
  v_new_avg numeric(19,4);
  v_line integer := 0;
  v_total numeric(19,4) := 0;
begin
  if not exists (
    select 1 from public.profiles
    where user_id = p_actor_id and tenant_id = p_tenant_id and active
      and role in ('OWNER','ADMIN','PURCHASING')
  ) then
    raise exception 'Akun tidak memiliki hak menerima pembelian';
  end if;

  select name into v_supplier_name
  from public.suppliers
  where id = p_supplier_id and tenant_id = p_tenant_id and active;
  if v_supplier_name is null then raise exception 'Supplier tidak valid'; end if;

  if not exists (
    select 1 from public.stock_locations
    where id = p_location_id and tenant_id = p_tenant_id
  ) then
    raise exception 'Lokasi penerimaan tidak valid';
  end if;

  if nullif(btrim(p_document_no), '') is null then
    raise exception 'Nomor dokumen pembelian wajib diisi';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'Idempotency key wajib diisi';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Tambahkan minimal satu barang restok';
  end if;

  select * into v_existing
  from public.purchase_receipts
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'id', v_existing.id,
      'document_no', v_existing.document_no,
      'supplier_name', v_existing.supplier_name,
      'occurred_at', v_existing.occurred_at,
      'status', v_existing.status,
      'duplicate', true
    );
  end if;

  insert into public.purchase_receipts(
    tenant_id, supplier_id, supplier_name, location_id, document_no,
    idempotency_key, actor_id, status
  ) values (
    p_tenant_id, p_supplier_id, v_supplier_name, p_location_id, btrim(p_document_no),
    p_idempotency_key, p_actor_id, 'RECEIVED'
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    select * into v_existing
    from public.purchase_receipts
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object(
      'id', v_existing.id,
      'document_no', v_existing.document_no,
      'supplier_name', v_existing.supplier_name,
      'occurred_at', v_existing.occurred_at,
      'status', v_existing.status,
      'duplicate', true
    );
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    v_product_id := nullif(v_item->>'productId', '')::uuid;
    v_qty := (v_item->>'baseQty')::numeric;
    v_cost := (v_item->>'unitCost')::numeric;
    v_batch := nullif(btrim(v_item->>'batchNo'), '');
    v_expires := nullif(v_item->>'expiresOn', '')::date;

    if not exists (
      select 1 from public.products
      where id = v_product_id and tenant_id = p_tenant_id and active
    ) then
      raise exception 'Produk pada baris % tidak valid', v_line;
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Jumlah pada baris % harus lebih dari nol', v_line;
    end if;
    if v_cost is null or v_cost < 0 then
      raise exception 'Modal pada baris % tidak valid', v_line;
    end if;

    insert into public.purchase_receipt_items(
      tenant_id, receipt_id, product_id, base_qty, unit_cost, batch_no, expires_on,
      supplier_id, supplier_name, document_no, received_at
    ) values (
      p_tenant_id, v_receipt_id, v_product_id, v_qty, v_cost, v_batch, v_expires,
      p_supplier_id, v_supplier_name, btrim(p_document_no), now()
    );

    insert into public.stock_balances(tenant_id, location_id, product_id)
    values(p_tenant_id, p_location_id, v_product_id)
    on conflict (location_id, product_id) do nothing;

    select quantity, avg_cost into v_balance_qty, v_balance_cost
    from public.stock_balances
    where location_id = p_location_id and product_id = v_product_id
    for update;

    v_new_qty := v_balance_qty + v_qty;
    v_new_avg := case
      when v_new_qty = 0 then 0
      when v_balance_qty <= 0 then v_cost
      else round(((v_balance_qty * v_balance_cost) + (v_qty * v_cost)) / v_new_qty, 4)
    end;

    update public.stock_balances
    set quantity = v_new_qty, avg_cost = v_new_avg,
        version = version + 1, updated_at = now()
    where location_id = p_location_id and product_id = v_product_id;

    insert into public.stock_ledger(
      tenant_id, location_id, product_id, delta, balance_after, unit_cost,
      event_type, reference_id, note, actor_id, idempotency_key
    ) values (
      p_tenant_id, p_location_id, v_product_id, v_qty, v_new_qty, v_cost,
      'PURCHASE_RECEIPT', v_receipt_id,
      concat_ws(' · ', btrim(p_document_no), case when v_batch is not null then 'batch ' || v_batch end),
      p_actor_id, p_idempotency_key || ':stock:' || v_line
    );

    v_total := v_total + (v_qty * v_cost);
  end loop;

  insert into public.audit_logs(
    tenant_id, actor_id, action, entity_type, entity_id, details_json
  ) values (
    p_tenant_id, p_actor_id, 'PURCHASE_RECEIVED', 'purchase_receipt', v_receipt_id,
    jsonb_build_object(
      'document_no', btrim(p_document_no),
      'supplier_id', p_supplier_id,
      'supplier_name', v_supplier_name,
      'location_id', p_location_id,
      'item_count', v_line,
      'total_cost', v_total
    )
  );

  return jsonb_build_object(
    'id', v_receipt_id,
    'document_no', btrim(p_document_no),
    'supplier_name', v_supplier_name,
    'status', 'RECEIVED',
    'item_count', v_line,
    'total_cost', v_total,
    'occurred_at', now(),
    'duplicate', false
  );
end;
$$;

revoke all on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) from public;
grant execute on function public.receive_purchase(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
