-- Kasir Nusa POS - Purchase Order, approval and partial receiving workflow

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  po_no text not null,
  supplier_id uuid not null references public.suppliers(id),
  supplier_name text not null,
  location_id uuid not null references public.stock_locations(id),
  expected_on date,
  notes text,
  status text not null default 'DRAFT' check(status in ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  subtotal numeric(19,4) not null default 0,
  discount_amount numeric(19,4) not null default 0,
  tax_amount numeric(19,4) not null default 0,
  other_cost numeric(19,4) not null default 0,
  grand_total numeric(19,4) not null default 0,
  created_by uuid not null references public.profiles(user_id),
  approved_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_at timestamptz,
  cancelled_at timestamptz,
  unique(tenant_id, po_no)
);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  ordered_qty numeric(19,6) not null check(ordered_qty > 0),
  received_qty numeric(19,6) not null default 0 check(received_qty >= 0),
  unit_cost numeric(19,4) not null check(unit_cost >= 0),
  line_discount numeric(19,4) not null default 0 check(line_discount >= 0),
  line_total numeric(19,4) not null check(line_total >= 0),
  unique(order_id, product_id),
  check(received_qty <= ordered_qty)
);

alter table public.purchase_receipts
  add column if not exists order_id uuid references public.purchase_orders(id);

create index if not exists purchase_orders_status_idx
  on public.purchase_orders(tenant_id, status, created_at desc);
create index if not exists purchase_order_items_order_idx
  on public.purchase_order_items(tenant_id, order_id);

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
drop policy if exists tenant_isolation on public.purchase_orders;
drop policy if exists tenant_isolation on public.purchase_order_items;
create policy tenant_isolation on public.purchase_orders for all to authenticated
  using (tenant_id=public.current_tenant_id()) with check (tenant_id=public.current_tenant_id());
create policy tenant_isolation on public.purchase_order_items for all to authenticated
  using (tenant_id=public.current_tenant_id()) with check (tenant_id=public.current_tenant_id());

create or replace function public.save_purchase_order(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_order_id uuid,
  p_supplier_id uuid,
  p_location_id uuid,
  p_expected_on date,
  p_notes text,
  p_discount_amount numeric,
  p_tax_amount numeric,
  p_other_cost numeric,
  p_items jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_order_id uuid;
  v_po_no text;
  v_supplier_name text;
  v_sequence bigint;
  v_item jsonb;
  v_product_id uuid;
  v_product_name text;
  v_qty numeric(19,6);
  v_cost numeric(19,4);
  v_line_discount numeric(19,4);
  v_line_total numeric(19,4);
  v_subtotal numeric(19,4) := 0;
  v_grand_total numeric(19,4);
  v_count integer := 0;
begin
  if not exists (
    select 1 from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active
      and role in ('OWNER','ADMIN','PURCHASING')
  ) then raise exception 'Akun tidak memiliki hak membuat Purchase Order'; end if;

  select name into v_supplier_name from public.suppliers
  where id=p_supplier_id and tenant_id=p_tenant_id and active;
  if v_supplier_name is null then raise exception 'Supplier tidak valid'; end if;
  if not exists(select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id) then
    raise exception 'Lokasi tujuan tidak valid';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Tambahkan minimal satu barang ke Purchase Order';
  end if;
  if coalesce(p_discount_amount,0)<0 or coalesce(p_tax_amount,0)<0 or coalesce(p_other_cost,0)<0 then
    raise exception 'Diskon, pajak, dan biaya tambahan tidak boleh negatif';
  end if;

  if p_order_id is null then
    insert into public.document_sequences(tenant_id,kind,next_value)
    values(p_tenant_id,'PURCHASE_ORDER',2)
    on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1
    returning next_value-1 into v_sequence;
    v_po_no := 'PO-' || to_char(now(),'YYMM') || '-' || lpad(v_sequence::text,5,'0');
    insert into public.purchase_orders(
      tenant_id,po_no,supplier_id,supplier_name,location_id,expected_on,notes,status,created_by
    ) values (
      p_tenant_id,v_po_no,p_supplier_id,v_supplier_name,p_location_id,p_expected_on,nullif(btrim(p_notes),''),'DRAFT',p_actor_id
    ) returning id into v_order_id;
  else
    select id,po_no into v_order_id,v_po_no from public.purchase_orders
    where id=p_order_id and tenant_id=p_tenant_id and status='DRAFT' for update;
    if v_order_id is null then raise exception 'Hanya Purchase Order berstatus Draft yang dapat diubah'; end if;
    update public.purchase_orders set supplier_id=p_supplier_id,supplier_name=v_supplier_name,
      location_id=p_location_id,expected_on=p_expected_on,notes=nullif(btrim(p_notes),''),updated_at=now()
    where id=v_order_id;
    delete from public.purchase_order_items where order_id=v_order_id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product_id := nullif(v_item->>'productId','')::uuid;
    v_qty := (v_item->>'baseQty')::numeric;
    v_cost := (v_item->>'unitCost')::numeric;
    v_line_discount := coalesce(nullif(v_item->>'lineDiscount','')::numeric,0);
    select name into v_product_name from public.products
    where id=v_product_id and tenant_id=p_tenant_id and active;
    if v_product_name is null then raise exception 'Produk pada baris % tidak valid',v_count+1; end if;
    if v_qty is null or v_qty<=0 then raise exception 'Jumlah pesanan harus lebih dari nol'; end if;
    if v_cost is null or v_cost<0 then raise exception 'Modal pesanan tidak valid'; end if;
    v_line_total := greatest(0,(v_qty*v_cost)-v_line_discount);
    insert into public.purchase_order_items(
      tenant_id,order_id,product_id,product_name,ordered_qty,received_qty,unit_cost,line_discount,line_total
    ) values (p_tenant_id,v_order_id,v_product_id,v_product_name,v_qty,0,v_cost,v_line_discount,v_line_total);
    v_subtotal := v_subtotal+v_line_total;
    v_count := v_count+1;
  end loop;

  v_grand_total := greatest(0,v_subtotal-coalesce(p_discount_amount,0)+coalesce(p_tax_amount,0)+coalesce(p_other_cost,0));
  update public.purchase_orders set subtotal=v_subtotal,discount_amount=coalesce(p_discount_amount,0),
    tax_amount=coalesce(p_tax_amount,0),other_cost=coalesce(p_other_cost,0),grand_total=v_grand_total,updated_at=now()
  where id=v_order_id;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_ORDER_DRAFT_SAVED','purchase_order',v_order_id,
    jsonb_build_object('po_no',v_po_no,'supplier_name',v_supplier_name,'item_count',v_count,'grand_total',v_grand_total));
  return jsonb_build_object('id',v_order_id,'po_no',v_po_no,'status','DRAFT','item_count',v_count,'grand_total',v_grand_total);
end $$;

create or replace function public.transition_purchase_order(
  p_tenant_id uuid,p_actor_id uuid,p_order_id uuid,p_action text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_order public.purchase_orders%rowtype; v_role text; v_next text;
begin
  select role into v_role from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null then raise exception 'Akun tidak aktif'; end if;
  select * into v_order from public.purchase_orders
  where id=p_order_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Purchase Order tidak ditemukan'; end if;

  if p_action='SUBMIT' then
    if v_role not in ('OWNER','ADMIN','PURCHASING') or v_order.status<>'DRAFT' then raise exception 'Purchase Order tidak dapat diajukan'; end if;
    v_next:='SUBMITTED';
    update public.purchase_orders set status=v_next,submitted_at=now(),updated_at=now() where id=p_order_id;
  elsif p_action='APPROVE' then
    if v_role not in ('OWNER','ADMIN') or v_order.status<>'SUBMITTED' then raise exception 'Hanya Owner/Admin dapat menyetujui PO yang diajukan'; end if;
    v_next:='APPROVED';
    update public.purchase_orders set status=v_next,approved_by=p_actor_id,approved_at=now(),updated_at=now() where id=p_order_id;
  elsif p_action='CANCEL' then
    if v_role not in ('OWNER','ADMIN') and not (v_role='PURCHASING' and v_order.status='DRAFT') then raise exception 'Purchase Order tidak dapat dibatalkan'; end if;
    if v_order.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED') then raise exception 'Purchase Order yang sudah diterima tidak dapat dibatalkan'; end if;
    v_next:='CANCELLED';
    update public.purchase_orders set status=v_next,cancelled_at=now(),updated_at=now() where id=p_order_id;
  else raise exception 'Aksi Purchase Order tidak dikenal';
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_ORDER_'||v_next,'purchase_order',p_order_id,
    jsonb_build_object('po_no',v_order.po_no,'from_status',v_order.status,'to_status',v_next));
  return jsonb_build_object('id',p_order_id,'po_no',v_order.po_no,'status',v_next);
end $$;

create or replace function public.receive_purchase_order(
  p_tenant_id uuid,p_actor_id uuid,p_order_id uuid,p_idempotency_key text,
  p_document_no text,p_items jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_order public.purchase_orders%rowtype;
  v_item jsonb;
  v_order_item public.purchase_order_items%rowtype;
  v_qty numeric(19,6);
  v_receipt jsonb;
  v_all_received boolean;
  v_next text;
begin
  select * into v_order from public.purchase_orders
  where id=p_order_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Purchase Order tidak ditemukan'; end if;
  if v_order.status not in ('APPROVED','PARTIALLY_RECEIVED') then raise exception 'Purchase Order harus disetujui sebelum diterima'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Tambahkan barang yang diterima'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_order_item from public.purchase_order_items
    where order_id=p_order_id and product_id=(v_item->>'productId')::uuid for update;
    if not found then raise exception 'Barang tidak terdapat dalam Purchase Order'; end if;
    v_qty := (v_item->>'baseQty')::numeric;
    if v_qty is null or v_qty<=0 or v_order_item.received_qty+v_qty>v_order_item.ordered_qty then
      raise exception 'Jumlah diterima untuk % melebihi sisa pesanan',v_order_item.product_name;
    end if;
  end loop;

  v_receipt := public.receive_purchase(
    p_tenant_id,p_actor_id,p_idempotency_key,v_order.supplier_id,v_order.location_id,p_document_no,p_items
  );
  if coalesce((v_receipt->>'duplicate')::boolean,false) then
    return v_receipt || jsonb_build_object('order_id',p_order_id,'po_no',v_order.po_no,'po_status',v_order.status);
  end if;
  update public.purchase_receipts set order_id=p_order_id where id=(v_receipt->>'id')::uuid;

  for v_item in select value from jsonb_array_elements(p_items) loop
    update public.purchase_order_items set received_qty=received_qty+(v_item->>'baseQty')::numeric
    where order_id=p_order_id and product_id=(v_item->>'productId')::uuid;
  end loop;
  select bool_and(received_qty>=ordered_qty) into v_all_received
  from public.purchase_order_items where order_id=p_order_id;
  v_next := case when v_all_received then 'RECEIVED' else 'PARTIALLY_RECEIVED' end;
  update public.purchase_orders set status=v_next,updated_at=now() where id=p_order_id;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PURCHASE_ORDER_'||v_next,'purchase_order',p_order_id,
    jsonb_build_object('po_no',v_order.po_no,'receipt_id',v_receipt->>'id','document_no',p_document_no));
  return v_receipt || jsonb_build_object('order_id',p_order_id,'po_no',v_order.po_no,'po_status',v_next);
end $$;

revoke all on function public.save_purchase_order(uuid,uuid,uuid,uuid,uuid,date,text,numeric,numeric,numeric,jsonb) from public;
revoke all on function public.transition_purchase_order(uuid,uuid,uuid,text) from public;
revoke all on function public.receive_purchase_order(uuid,uuid,uuid,text,text,jsonb) from public;
grant execute on function public.save_purchase_order(uuid,uuid,uuid,uuid,uuid,date,text,numeric,numeric,numeric,jsonb) to service_role;
grant execute on function public.transition_purchase_order(uuid,uuid,uuid,text) to service_role;
grant execute on function public.receive_purchase_order(uuid,uuid,uuid,text,text,jsonb) to service_role;
