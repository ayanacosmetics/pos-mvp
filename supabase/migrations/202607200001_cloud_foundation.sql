-- Kasir Nusa POS cloud foundation for Supabase PostgreSQL.
-- Apply with Supabase CLI or paste into the SQL editor on a new project.
create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('OWNER','ADMIN','CASHIER','PURCHASING','WAREHOUSE')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.outlets (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null, name text not null, timezone text not null default 'Asia/Makassar', active boolean not null default true,
  unique(tenant_id, code)
);
create table if not exists public.stock_locations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id), code text not null, name text not null,
  kind text not null check(kind in ('STORE','WAREHOUSE','TRANSIT')), unique(tenant_id, code)
);
create table if not exists public.user_outlets (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  primary key(user_id, outlet_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null, name text not null, phone text, group_id text not null default 'retail' check(group_id in ('retail','wholesale')),
  active boolean not null default true, created_at timestamptz not null default now(), unique(tenant_id, code)
);
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null, name text not null, phone text, address text, active boolean not null default true,
  created_at timestamptz not null default now(), unique(tenant_id, code)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  sku text not null, name text not null, category text not null, brand text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id, sku)
);
create table if not exists public.product_units (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade, name text not null,
  factor_to_base numeric(19,6) not null check(factor_to_base > 0), barcode text,
  unique(product_id, name), unique(tenant_id, barcode)
);
create table if not exists public.price_rules (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  customer_group_id text check(customer_group_id in ('retail','wholesale')),
  min_base_qty numeric(19,6) not null default 1 check(min_base_qty > 0),
  unit_price_base numeric(19,4) not null check(unit_price_base >= 0), priority integer not null default 0,
  starts_at timestamptz, ends_at timestamptz
);

create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null, name text not null, created_at timestamptz not null default now(), unique(tenant_id, code)
);
create table if not exists public.promotion_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  version integer not null, status text not null check(status in ('DRAFT','PUBLISHED','RETIRED')),
  priority integer not null default 50, stackable boolean not null default false,
  starts_at timestamptz not null, ends_at timestamptz not null, rule_json jsonb not null,
  created_at timestamptz not null default now(), published_at timestamptz, unique(promotion_id, version)
);

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id), cashier_id uuid not null references public.profiles(user_id),
  opened_at timestamptz not null default now(), closed_at timestamptz,
  opening_cash numeric(19,4) not null default 0, expected_cash numeric(19,4), closing_cash numeric(19,4), difference numeric(19,4),
  status text not null check(status in ('OPEN','CLOSED'))
);
create unique index if not exists one_open_shift_per_cashier on public.shifts(cashier_id, outlet_id) where status='OPEN';
create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  shift_id uuid not null references public.shifts(id), movement_type text not null check(movement_type in ('CASH_IN','CASH_OUT')),
  amount numeric(19,4) not null check(amount > 0), note text not null, actor_id uuid not null references public.profiles(user_id),
  occurred_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id), shift_id uuid not null references public.shifts(id), customer_id uuid references public.customers(id),
  receipt_no text not null, idempotency_key text not null, cashier_id uuid not null references public.profiles(user_id),
  customer_group_id text not null, subtotal numeric(19,4) not null, discount_total numeric(19,4) not null,
  grand_total numeric(19,4) not null, cost_total numeric(19,4) not null default 0,
  payment_method text not null, status text not null default 'COMPLETED', occurred_at timestamptz not null default now(),
  unique(tenant_id, receipt_no), unique(tenant_id, idempotency_key)
);
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade, product_id uuid not null references public.products(id),
  product_name text not null, base_qty numeric(19,6) not null check(base_qty > 0), gross numeric(19,4) not null,
  discount numeric(19,4) not null, total numeric(19,4) not null, cost_total numeric(19,4) not null,
  pricing_snapshot jsonb not null default '{}', promotion_snapshot jsonb not null default '[]'
);
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade, method text not null,
  amount numeric(19,4) not null check(amount >= 0), reference text, created_at timestamptz not null default now()
);

create table if not exists public.purchase_receipts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid references public.suppliers(id), supplier_name text not null, location_id uuid not null references public.stock_locations(id),
  document_no text not null, idempotency_key text not null, actor_id uuid not null references public.profiles(user_id),
  status text not null default 'RECEIVED', occurred_at timestamptz not null default now(),
  unique(tenant_id, document_no), unique(tenant_id, idempotency_key)
);
create table if not exists public.purchase_receipt_items (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  receipt_id uuid not null references public.purchase_receipts(id) on delete cascade,
  product_id uuid not null references public.products(id), base_qty numeric(19,6) not null check(base_qty > 0),
  unit_cost numeric(19,4) not null check(unit_cost >= 0), batch_no text, expires_on date
);

create table if not exists public.stock_balances (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id), product_id uuid not null references public.products(id),
  quantity numeric(19,6) not null default 0, avg_cost numeric(19,4) not null default 0,
  version bigint not null default 0, updated_at timestamptz not null default now(), primary key(location_id, product_id)
);
create table if not exists public.stock_ledger (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.stock_locations(id), product_id uuid not null references public.products(id),
  delta numeric(19,6) not null, balance_after numeric(19,6) not null, unit_cost numeric(19,4) not null,
  event_type text not null, reference_id uuid not null, note text, actor_id uuid references public.profiles(user_id),
  idempotency_key text not null, occurred_at timestamptz not null default now(), unique(tenant_id, idempotency_key)
);
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid references public.profiles(user_id), action text not null, entity_type text not null,
  entity_id uuid, details_json jsonb not null default '{}', occurred_at timestamptz not null default now()
);
create table if not exists public.sync_commands (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid not null, idempotency_key text not null, command_type text not null,
  payload jsonb not null, status text not null, error_json jsonb, received_at timestamptz not null default now(),
  unique(tenant_id, device_id, idempotency_key)
);
create table if not exists public.document_sequences (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null, next_value bigint not null default 1, primary key(tenant_id, kind)
);

create or replace function public.current_tenant_id() returns uuid language sql stable security definer set search_path=public as $$
  select tenant_id from public.profiles where user_id=auth.uid() and active=true
$$;
create or replace function public.current_app_role() returns text language sql stable security definer set search_path=public as $$
  select role from public.profiles where user_id=auth.uid() and active=true
$$;

alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
create policy tenant_members_read_tenant on public.tenants for select to authenticated using(id=public.current_tenant_id());
create policy users_read_own_profile on public.profiles for select to authenticated using(user_id=auth.uid());

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'outlets','stock_locations','user_outlets','customers','suppliers','products','product_units','price_rules',
    'promotions','promotion_versions','shifts','cash_movements','sales','sale_items','payments','purchase_receipts',
    'purchase_receipt_items','stock_balances','stock_ledger','audit_logs','sync_commands','document_sequences'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy tenant_isolation on public.%I for all to authenticated using (tenant_id=public.current_tenant_id()) with check (tenant_id=public.current_tenant_id())', table_name);
  end loop;
end $$;

create or replace function public.bootstrap_owner(p_user_id uuid, p_display_name text, p_business_name text default 'Kasir Nusa')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_outlet uuid; v_store uuid; v_warehouse uuid;
begin
  if exists(select 1 from public.profiles where user_id=p_user_id) then
    select tenant_id into v_tenant from public.profiles where user_id=p_user_id;
    return jsonb_build_object('tenant_id',v_tenant,'existing',true);
  end if;
  insert into public.tenants(name) values(p_business_name) returning id into v_tenant;
  insert into public.profiles(user_id,tenant_id,display_name,role) values(p_user_id,v_tenant,p_display_name,'OWNER');
  insert into public.outlets(tenant_id,code,name) values(v_tenant,'UTM','Toko Utama') returning id into v_outlet;
  insert into public.stock_locations(tenant_id,outlet_id,code,name,kind) values(v_tenant,v_outlet,'TOKO','Toko Utama','STORE') returning id into v_store;
  insert into public.stock_locations(tenant_id,outlet_id,code,name,kind) values(v_tenant,v_outlet,'GDG','Gudang Utama','WAREHOUSE') returning id into v_warehouse;
  insert into public.user_outlets(tenant_id,user_id,outlet_id) values(v_tenant,p_user_id,v_outlet);
  insert into public.customers(tenant_id,code,name,group_id) values(v_tenant,'PLG-0001','Pelanggan Umum','retail');
  return jsonb_build_object('tenant_id',v_tenant,'outlet_id',v_outlet,'store_location_id',v_store,'warehouse_location_id',v_warehouse,'existing',false);
end $$;

create or replace function public.create_product(p_tenant_id uuid, p_actor_id uuid, p_product jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_product uuid; v_unit uuid; v_location record;
begin
  insert into public.products(tenant_id,sku,name,category,brand)
  values(p_tenant_id,p_product->>'sku',p_product->>'name',coalesce(nullif(p_product->>'category',''),'Lainnya'),nullif(p_product->>'brand','')) returning id into v_product;
  insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode)
  values(p_tenant_id,v_product,coalesce(nullif(p_product->>'unitName',''),'pcs'),1,nullif(p_product->>'barcode','')) returning id into v_unit;
  insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base)
  values(p_tenant_id,v_product,'retail',1,(p_product->>'retailPrice')::numeric);
  if coalesce((p_product->>'wholesalePrice')::numeric,0)>0 then
    insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base)
    values(p_tenant_id,v_product,'wholesale',1,(p_product->>'wholesalePrice')::numeric);
  end if;
  if coalesce((p_product->>'tierQty')::numeric,0)>1 and coalesce((p_product->>'tierPrice')::numeric,0)>0 then
    insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base)
    values(p_tenant_id,v_product,null,(p_product->>'tierQty')::numeric,(p_product->>'tierPrice')::numeric);
  end if;
  for v_location in select id from public.stock_locations where tenant_id=p_tenant_id loop
    insert into public.stock_balances(tenant_id,location_id,product_id) values(p_tenant_id,v_location.id,v_product);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PRODUCT_CREATED','product',v_product,jsonb_build_object('sku',p_product->>'sku'));
  return jsonb_build_object('id',v_product,'unit_id',v_unit);
end $$;

create or replace function public.publish_promotion(p_tenant_id uuid, p_actor_id uuid, p_rule jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_promotion uuid; v_version integer; v_version_id uuid;
begin
  select id into v_promotion from public.promotions where tenant_id=p_tenant_id and code=upper(p_rule->>'code');
  if v_promotion is null then
    insert into public.promotions(tenant_id,code,name) values(p_tenant_id,upper(p_rule->>'code'),p_rule->>'name') returning id into v_promotion;
  end if;
  select coalesce(max(version),0)+1 into v_version from public.promotion_versions where promotion_id=v_promotion;
  update public.promotion_versions set status='RETIRED' where promotion_id=v_promotion and status='PUBLISHED';
  insert into public.promotion_versions(tenant_id,promotion_id,version,status,priority,stackable,starts_at,ends_at,rule_json,published_at)
  values(p_tenant_id,v_promotion,v_version,'PUBLISHED',coalesce((p_rule->>'priority')::int,50),coalesce((p_rule->>'stackable')::boolean,false),
    coalesce((p_rule->>'startsAt')::timestamptz,now()),coalesce((p_rule->>'endsAt')::timestamptz,now()+interval '30 days'),
    jsonb_build_object('condition',jsonb_build_object('category',p_rule->>'category','minBaseQty',(p_rule->>'minBaseQty')::numeric),
      'reward',jsonb_build_object('type','PERCENT_ITEM','value',(p_rule->>'discountPercent')::numeric,'maxDiscount',coalesce((p_rule->>'maxDiscount')::numeric,100000))),now())
  returning id into v_version_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PROMOTION_PUBLISHED','promotion',v_promotion,jsonb_build_object('version',v_version));
  return jsonb_build_object('id',v_version_id,'promotionId',v_promotion,'version',v_version,'status','PUBLISHED');
end $$;

create or replace function public.complete_sale(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_outlet_id uuid,
  p_shift_id uuid, p_customer_id uuid, p_customer_group_id text, p_payment_method text, p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_sale uuid; v_existing record; v_location uuid; v_line jsonb; v_balance record; v_cost numeric:=0; v_line_cost numeric; v_seq bigint; v_receipt text;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true); end if;
  if not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and cashier_id=p_actor_id and status='OPEN') then
    raise exception 'Shift kasir belum dibuka';
  end if;
  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' limit 1;
  if v_location is null then raise exception 'Lokasi stok toko tidak ditemukan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:='UTM-'||lpad(v_seq::text,6,'0');
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,
    (p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,(p_quote->>'grandTotal')::numeric,0,p_payment_method) returning id into v_sale;
  for v_line in select * from jsonb_array_elements(p_quote->'lines') loop
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=(v_line->>'productId')::uuid for update;
    if not found or v_balance.quantity < (v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName'; end if;
    v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric; v_cost:=v_cost+v_line_cost;
    update public.stock_balances set quantity=quantity-(v_line->>'baseQty')::numeric,version=version+1,updated_at=now()
    where location_id=v_location and product_id=(v_line->>'productId')::uuid;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key)
    values(p_tenant_id,v_location,(v_line->>'productId')::uuid,-(v_line->>'baseQty')::numeric,v_balance.quantity-(v_line->>'baseQty')::numeric,
      v_balance.avg_cost,'SALE',v_sale,p_actor_id,p_idempotency_key||':stock:'||(v_line->>'productId'));
    insert into public.sale_items(tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,pricing_snapshot,promotion_snapshot)
    values(p_tenant_id,v_sale,(v_line->>'productId')::uuid,v_line->>'productName',(v_line->>'baseQty')::numeric,(v_line->>'gross')::numeric,
      (v_line->>'discount')::numeric,(v_line->>'total')::numeric,v_line_cost,jsonb_build_object('priceRuleId',v_line->>'priceRuleId'),coalesce(v_line->'promotions','[]'));
  end loop;
  update public.sales set cost_total=v_cost where id=v_sale;
  insert into public.payments(tenant_id,sale_id,method,amount) values(p_tenant_id,v_sale,p_payment_method,(p_quote->>'grandTotal')::numeric);
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,jsonb_build_object('receiptNo',v_receipt,'grandTotal',p_quote->>'grandTotal'));
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false);
end $$;

revoke all on function public.bootstrap_owner(uuid,text,text) from public,anon,authenticated;
revoke all on function public.create_product(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.publish_promotion(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.complete_sale(uuid,uuid,text,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.bootstrap_owner(uuid,text,text) to service_role;
grant execute on function public.create_product(uuid,uuid,jsonb) to service_role;
grant execute on function public.publish_promotion(uuid,uuid,jsonb) to service_role;
grant execute on function public.complete_sale(uuid,uuid,text,uuid,uuid,uuid,text,text,jsonb) to service_role;

grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;

create index if not exists stock_ledger_lookup on public.stock_ledger(tenant_id,location_id,product_id,occurred_at desc);
create index if not exists sales_report_lookup on public.sales(tenant_id,occurred_at desc,status);
create index if not exists price_rule_lookup on public.price_rules(tenant_id,product_id,min_base_qty desc);
create index if not exists promotion_active_lookup on public.promotion_versions(tenant_id,status,starts_at,ends_at);
