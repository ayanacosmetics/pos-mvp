-- Kasir Nusa POS v1.27 - advanced multi-outlet operations
-- Transfer approval/dispatch/receipt, outlet price and promotion scope,
-- outlet manager access, consolidation alerts.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check(role in ('OWNER','ADMIN','MANAGER','CASHIER','PURCHASING','WAREHOUSE'));

create table if not exists public.transfer_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_no text not null,
  idempotency_key text not null,
  from_location_id uuid not null references public.stock_locations(id),
  to_location_id uuid not null references public.stock_locations(id),
  status text not null default 'REQUESTED'
    check(status in ('REQUESTED','APPROVED','IN_TRANSIT','RECEIVED','REJECTED','CANCELLED')),
  note text,
  requested_by uuid not null references public.profiles(user_id),
  approved_by uuid references public.profiles(user_id),
  shipped_by uuid references public.profiles(user_id),
  received_by uuid references public.profiles(user_id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  shipped_at timestamptz,
  received_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(tenant_id,transfer_no),
  unique(tenant_id,idempotency_key),
  check(from_location_id<>to_location_id)
);

create table if not exists public.transfer_request_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_request_id uuid not null references public.transfer_requests(id) on delete cascade,
  product_id uuid not null references public.products(id),
  requested_qty numeric(19,6) not null check(requested_qty>0),
  shipped_qty numeric(19,6) not null default 0 check(shipped_qty>=0),
  received_qty numeric(19,6) not null default 0 check(received_qty>=0),
  unit_cost numeric(19,4) not null default 0 check(unit_cost>=0),
  unique(transfer_request_id,product_id)
);

create table if not exists public.transfer_request_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_request_id uuid not null references public.transfer_requests(id) on delete cascade,
  transfer_item_id uuid not null references public.transfer_request_items(id) on delete cascade,
  source_batch_id uuid references public.inventory_batches(id),
  supplier_id uuid references public.suppliers(id),
  supplier_name text,
  batch_no text,
  expires_on date,
  quantity numeric(19,6) not null check(quantity>0),
  unit_cost numeric(19,4) not null check(unit_cost>=0)
);

create table if not exists public.outlet_price_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  customer_group_id text not null default 'retail'
    check(customer_group_id in ('retail','wholesale')),
  min_base_qty numeric(19,6) not null default 1 check(min_base_qty>0),
  unit_price_base numeric(19,4) not null check(unit_price_base>=0),
  active boolean not null default true,
  updated_by uuid references public.profiles(user_id),
  updated_at timestamptz not null default now(),
  unique(tenant_id,outlet_id,product_id,customer_group_id,min_base_qty)
);

create table if not exists public.promotion_outlets (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  promotion_version_id uuid not null references public.promotion_versions(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  assigned_by uuid references public.profiles(user_id),
  assigned_at timestamptz not null default now(),
  primary key(promotion_version_id,outlet_id)
);

create table if not exists public.operational_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id) on delete cascade,
  notification_type text not null check(notification_type in ('CRITICAL_STOCK','UNUSUAL_ACTIVITY')),
  severity text not null check(severity in ('INFO','WARNING','CRITICAL')),
  fingerprint text not null,
  title text not null,
  message text not null,
  entity_type text,
  entity_id uuid,
  status text not null default 'OPEN' check(status in ('OPEN','ACKNOWLEDGED','DISMISSED')),
  detected_at timestamptz not null default now(),
  acknowledged_by uuid references public.profiles(user_id),
  acknowledged_at timestamptz,
  unique(tenant_id,fingerprint)
);

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'transfer_requests','transfer_request_items','transfer_request_batches',
    'outlet_price_overrides','promotion_outlets','operational_notifications'
  ] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('drop policy if exists tenant_isolation on public.%I',v_table);
    execute format(
      'create policy tenant_isolation on public.%I for all to authenticated using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id())',
      v_table
    );
  end loop;
end $$;

create index if not exists transfer_requests_status_idx
  on public.transfer_requests(tenant_id,status,updated_at desc);
create index if not exists transfer_request_items_product_idx
  on public.transfer_request_items(tenant_id,product_id);
create index if not exists transfer_request_batches_transfer_idx
  on public.transfer_request_batches(transfer_request_id,transfer_item_id);
create index if not exists outlet_price_overrides_lookup_idx
  on public.outlet_price_overrides(tenant_id,outlet_id,product_id,active);
create index if not exists promotion_outlets_outlet_idx
  on public.promotion_outlets(tenant_id,outlet_id,promotion_version_id);
create index if not exists operational_notifications_open_idx
  on public.operational_notifications(tenant_id,status,detected_at desc);

create or replace function public.request_stock_transfer_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,
  p_from_location_id uuid,p_to_location_id uuid,p_note text,p_items jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_role text; v_existing public.transfer_requests%rowtype; v_transfer uuid;
  v_seq bigint; v_no text; v_item jsonb; v_product uuid; v_qty numeric; v_count integer:=0;
begin
  select role into v_role from public.profiles
    where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER','WAREHOUSE') then
    raise exception 'Akun tidak dapat membuat permintaan transfer';
  end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transfer wajib diisi'; end if;
  select * into v_existing from public.transfer_requests
    where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'transferNo',v_existing.transfer_no,'status',v_existing.status,'duplicate',true);
  end if;
  if p_from_location_id=p_to_location_id then raise exception 'Lokasi asal dan tujuan harus berbeda'; end if;
  if not exists(select 1 from public.stock_locations where id=p_from_location_id and tenant_id=p_tenant_id)
    or not exists(select 1 from public.stock_locations where id=p_to_location_id and tenant_id=p_tenant_id)
    then raise exception 'Lokasi transfer tidak valid';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Barang transfer wajib diisi'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*)>1)
    then raise exception 'Produk transfer tidak boleh digandakan';
  end if;

  insert into public.document_sequences(tenant_id,kind,next_value)
  values(p_tenant_id,'TRANSFER_REQUEST',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1
  returning next_value-1 into v_seq;
  v_no:='MTA-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into public.transfer_requests(
    tenant_id,transfer_no,idempotency_key,from_location_id,to_location_id,note,requested_by
  ) values(
    p_tenant_id,v_no,p_idempotency_key,p_from_location_id,p_to_location_id,
    nullif(trim(p_note),''),p_actor_id
  ) returning id into v_transfer;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product:=(v_item->>'productId')::uuid;
    v_qty:=(v_item->>'baseQty')::numeric;
    if v_qty<=0 then raise exception 'Jumlah transfer harus lebih dari nol'; end if;
    if not exists(select 1 from public.products where id=v_product and tenant_id=p_tenant_id and active)
      then raise exception 'Produk transfer tidak valid';
    end if;
    insert into public.transfer_request_items(tenant_id,transfer_request_id,product_id,requested_qty)
    values(p_tenant_id,v_transfer,v_product,v_qty);
    v_count:=v_count+1;
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'TRANSFER_REQUESTED','transfer_request',v_transfer,
    jsonb_build_object('transferNo',v_no,'fromLocationId',p_from_location_id,'toLocationId',p_to_location_id,'itemCount',v_count));
  return jsonb_build_object('id',v_transfer,'transferNo',v_no,'status','REQUESTED','duplicate',false);
end $$;

create or replace function public.advance_stock_transfer_v1(
  p_tenant_id uuid,p_actor_id uuid,p_transfer_id uuid,p_action text,p_note text default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_role text; v_transfer public.transfer_requests%rowtype; v_action text:=upper(trim(p_action));
  v_item public.transfer_request_items%rowtype; v_balance public.stock_balances%rowtype;
  v_dest public.stock_balances%rowtype; v_lot record; v_remaining numeric; v_take numeric;
  v_batch uuid; v_index integer:=0;
begin
  select role into v_role from public.profiles
    where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER','WAREHOUSE') then
    raise exception 'Akun tidak dapat memproses transfer';
  end if;
  select * into v_transfer from public.transfer_requests
    where id=p_transfer_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Dokumen transfer tidak ditemukan'; end if;

  if v_action='APPROVE' then
    if v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Transfer harus disetujui Owner, Admin, atau Manajer Outlet'; end if;
    if v_transfer.status<>'REQUESTED' then raise exception 'Hanya permintaan baru yang dapat disetujui'; end if;
    update public.transfer_requests set status='APPROVED',approved_by=p_actor_id,approved_at=now(),
      note=coalesce(nullif(trim(p_note),''),note),updated_at=now() where id=p_transfer_id;
  elsif v_action='REJECT' then
    if v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Transfer harus ditolak Owner, Admin, atau Manajer Outlet'; end if;
    if v_transfer.status<>'REQUESTED' then raise exception 'Hanya permintaan baru yang dapat ditolak'; end if;
    update public.transfer_requests set status='REJECTED',approved_by=p_actor_id,approved_at=now(),
      note=coalesce(nullif(trim(p_note),''),note),updated_at=now() where id=p_transfer_id;
  elsif v_action='CANCEL' then
    if v_transfer.status not in ('REQUESTED','APPROVED') then raise exception 'Transfer yang sudah dikirim tidak dapat dibatalkan'; end if;
    if v_role not in ('OWNER','ADMIN','MANAGER') and v_transfer.requested_by<>p_actor_id
      then raise exception 'Hanya pembuat atau supervisor yang dapat membatalkan';
    end if;
    update public.transfer_requests set status='CANCELLED',
      note=coalesce(nullif(trim(p_note),''),note),updated_at=now() where id=p_transfer_id;
  elsif v_action='SHIP' then
    if v_transfer.status<>'APPROVED' then raise exception 'Transfer harus disetujui sebelum dikirim'; end if;
    for v_item in select * from public.transfer_request_items
      where transfer_request_id=p_transfer_id order by id for update
    loop
      v_index:=v_index+1;
      select * into v_balance from public.stock_balances
        where tenant_id=p_tenant_id and location_id=v_transfer.from_location_id
          and product_id=v_item.product_id for update;
      if not found or v_balance.quantity<v_item.requested_qty then
        raise exception 'Stok produk tidak cukup untuk dikirim';
      end if;
      update public.stock_balances set quantity=quantity-v_item.requested_qty,
        version=version+1,updated_at=now()
        where location_id=v_transfer.from_location_id and product_id=v_item.product_id;
      update public.transfer_request_items set shipped_qty=requested_qty,unit_cost=v_balance.avg_cost
        where id=v_item.id;
      insert into public.stock_ledger(
        tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,
        reference_id,note,actor_id,idempotency_key
      ) values(
        p_tenant_id,v_transfer.from_location_id,v_item.product_id,-v_item.requested_qty,
        v_balance.quantity-v_item.requested_qty,v_balance.avg_cost,'TRANSFER_DISPATCH',
        p_transfer_id,v_transfer.transfer_no,p_actor_id,
        'transfer-request:'||p_transfer_id::text||':dispatch:'||v_index::text
      );
      v_remaining:=v_item.requested_qty;
      for v_lot in select * from public.inventory_batches
        where tenant_id=p_tenant_id and location_id=v_transfer.from_location_id
          and product_id=v_item.product_id and available_qty>0
        order by expires_on asc nulls last,received_at asc,id asc for update
      loop
        exit when v_remaining<=0;
        v_take:=least(v_remaining,v_lot.available_qty);
        update public.inventory_batches set available_qty=available_qty-v_take where id=v_lot.id;
        insert into public.inventory_batch_movements(
          tenant_id,batch_id,delta,balance_after,event_type,reference_id
        ) values(
          p_tenant_id,v_lot.id,-v_take,v_lot.available_qty-v_take,'TRANSFER_DISPATCH',p_transfer_id
        );
        insert into public.transfer_request_batches(
          tenant_id,transfer_request_id,transfer_item_id,source_batch_id,supplier_id,
          supplier_name,batch_no,expires_on,quantity,unit_cost
        ) values(
          p_tenant_id,p_transfer_id,v_item.id,v_lot.id,v_lot.supplier_id,
          v_lot.supplier_name,v_lot.batch_no,v_lot.expires_on,v_take,v_lot.unit_cost
        );
        v_remaining:=v_remaining-v_take;
      end loop;
      if v_remaining>0 then raise exception 'Saldo batch tidak cukup. Jalankan rekonsiliasi stok'; end if;
    end loop;
    update public.transfer_requests set status='IN_TRANSIT',shipped_by=p_actor_id,
      shipped_at=now(),updated_at=now() where id=p_transfer_id;
  elsif v_action='RECEIVE' then
    if v_transfer.status<>'IN_TRANSIT' then raise exception 'Hanya transfer dalam perjalanan yang dapat diterima'; end if;
    for v_item in select * from public.transfer_request_items
      where transfer_request_id=p_transfer_id order by id for update
    loop
      v_index:=v_index+1;
      insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost,version,updated_at)
      values(p_tenant_id,v_transfer.to_location_id,v_item.product_id,v_item.shipped_qty,v_item.unit_cost,1,now())
      on conflict(location_id,product_id) do update set
        avg_cost=case when public.stock_balances.quantity+excluded.quantity=0 then 0 else
          ((public.stock_balances.quantity*public.stock_balances.avg_cost)
          +(excluded.quantity*excluded.avg_cost))/(public.stock_balances.quantity+excluded.quantity) end,
        quantity=public.stock_balances.quantity+excluded.quantity,
        version=public.stock_balances.version+1,updated_at=now();
      select * into v_dest from public.stock_balances
        where location_id=v_transfer.to_location_id and product_id=v_item.product_id;
      insert into public.stock_ledger(
        tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,
        reference_id,note,actor_id,idempotency_key
      ) values(
        p_tenant_id,v_transfer.to_location_id,v_item.product_id,v_item.shipped_qty,
        v_dest.quantity,v_item.unit_cost,'TRANSFER_RECEIVE',p_transfer_id,
        v_transfer.transfer_no,p_actor_id,
        'transfer-request:'||p_transfer_id::text||':receive:'||v_index::text
      );
      for v_lot in select * from public.transfer_request_batches
        where transfer_item_id=v_item.id order by id
      loop
        insert into public.inventory_batches(
          tenant_id,location_id,product_id,supplier_id,supplier_name,batch_no,expires_on,
          received_qty,available_qty,unit_cost,received_at,source_batch_id
        ) values(
          p_tenant_id,v_transfer.to_location_id,v_item.product_id,v_lot.supplier_id,
          v_lot.supplier_name,v_lot.batch_no,v_lot.expires_on,v_lot.quantity,
          v_lot.quantity,v_lot.unit_cost,now(),v_lot.source_batch_id
        ) returning id into v_batch;
        insert into public.inventory_batch_movements(
          tenant_id,batch_id,delta,balance_after,event_type,reference_id
        ) values(p_tenant_id,v_batch,v_lot.quantity,v_lot.quantity,'TRANSFER_RECEIVE',p_transfer_id);
      end loop;
      update public.transfer_request_items set received_qty=shipped_qty where id=v_item.id;
    end loop;
    update public.transfer_requests set status='RECEIVED',received_by=p_actor_id,
      received_at=now(),updated_at=now() where id=p_transfer_id;
  else
    raise exception 'Tindakan transfer tidak valid';
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'TRANSFER_'||v_action,'transfer_request',p_transfer_id,
    jsonb_build_object('transferNo',v_transfer.transfer_no,'note',nullif(trim(p_note),'')));
  return jsonb_build_object(
    'id',p_transfer_id,'transferNo',v_transfer.transfer_no,
    'status',(select status from public.transfer_requests where id=p_transfer_id)
  );
end $$;

create or replace function public.save_outlet_price_override_v1(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_id uuid,p_product_id uuid,
  p_customer_group_id text,p_min_base_qty numeric,p_unit_price_base numeric,p_active boolean
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text; v_id uuid;
begin
  select role into v_role from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Akun tidak dapat mengubah harga outlet'; end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active)
    or not exists(select 1 from public.products where id=p_product_id and tenant_id=p_tenant_id and active)
    then raise exception 'Outlet atau produk tidak valid';
  end if;
  if p_customer_group_id not in ('retail','wholesale') or p_min_base_qty<=0 or p_unit_price_base<0
    then raise exception 'Aturan harga outlet tidak valid';
  end if;
  insert into public.outlet_price_overrides(
    tenant_id,outlet_id,product_id,customer_group_id,min_base_qty,unit_price_base,active,updated_by,updated_at
  ) values(
    p_tenant_id,p_outlet_id,p_product_id,p_customer_group_id,p_min_base_qty,p_unit_price_base,
    coalesce(p_active,true),p_actor_id,now()
  ) on conflict(tenant_id,outlet_id,product_id,customer_group_id,min_base_qty)
  do update set unit_price_base=excluded.unit_price_base,active=excluded.active,
    updated_by=excluded.updated_by,updated_at=now()
  returning id into v_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'OUTLET_PRICE_UPDATED','outlet_price_override',v_id,
    jsonb_build_object('outletId',p_outlet_id,'productId',p_product_id,'customerGroupId',p_customer_group_id,'price',p_unit_price_base));
  return jsonb_build_object('id',v_id,'active',coalesce(p_active,true));
end $$;

create or replace function public.assign_promotion_outlets_v1(
  p_tenant_id uuid,p_actor_id uuid,p_promotion_version_id uuid,p_outlet_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text; v_outlet uuid;
begin
  select role into v_role from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Akun tidak dapat mengatur promo outlet'; end if;
  if not exists(select 1 from public.promotion_versions where id=p_promotion_version_id and tenant_id=p_tenant_id)
    then raise exception 'Versi promo tidak ditemukan';
  end if;
  foreach v_outlet in array coalesce(p_outlet_ids,array[]::uuid[]) loop
    if not exists(select 1 from public.outlets where id=v_outlet and tenant_id=p_tenant_id and active)
      then raise exception 'Outlet promo tidak valid';
    end if;
  end loop;
  delete from public.promotion_outlets where tenant_id=p_tenant_id and promotion_version_id=p_promotion_version_id;
  foreach v_outlet in array coalesce(p_outlet_ids,array[]::uuid[]) loop
    insert into public.promotion_outlets(tenant_id,promotion_version_id,outlet_id,assigned_by)
    values(p_tenant_id,p_promotion_version_id,v_outlet,p_actor_id);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PROMOTION_OUTLETS_UPDATED','promotion_version',p_promotion_version_id,
    jsonb_build_object('outletIds',coalesce(p_outlet_ids,array[]::uuid[])));
  return jsonb_build_object('id',p_promotion_version_id,'outletIds',coalesce(to_jsonb(p_outlet_ids),'[]'::jsonb));
end $$;

create or replace function public.manage_profile_access(
  p_tenant_id uuid, p_actor_id uuid, p_user_id uuid, p_display_name text,
  p_role text, p_active boolean, p_outlet_ids uuid[]
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_target public.profiles%rowtype; v_outlet uuid; v_owner_count int; v_was_existing boolean;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then raise exception 'Hanya Owner yang dapat mengelola user'; end if;
  if p_role not in ('OWNER','ADMIN','MANAGER','CASHIER','PURCHASING','WAREHOUSE') then raise exception 'Peran user tidak valid'; end if;
  if nullif(trim(p_display_name),'') is null then raise exception 'Nama user wajib diisi'; end if;
  if p_user_id=p_actor_id and not p_active then raise exception 'Owner tidak dapat menonaktifkan akun sendiri'; end if;
  if p_role<>'OWNER' and coalesce(array_length(p_outlet_ids,1),0)=0 then raise exception 'User harus ditempatkan minimal pada satu outlet'; end if;
  foreach v_outlet in array coalesce(p_outlet_ids,array[]::uuid[]) loop
    if not exists(select 1 from public.outlets where id=v_outlet and tenant_id=p_tenant_id and active=true) then raise exception 'Outlet user tidak valid'; end if;
  end loop;
  select * into v_target from public.profiles where user_id=p_user_id for update;
  v_was_existing:=found;
  if found and v_target.tenant_id<>p_tenant_id then raise exception 'User sudah terhubung dengan usaha lain'; end if;
  if found and v_target.role='OWNER' and (p_role<>'OWNER' or not p_active) then
    select count(*) into v_owner_count from public.profiles where tenant_id=p_tenant_id and role='OWNER' and active=true;
    if v_owner_count<=1 then raise exception 'Usaha harus memiliki minimal satu Owner aktif'; end if;
  end if;
  insert into public.profiles(user_id,tenant_id,display_name,role,active)
  values(p_user_id,p_tenant_id,trim(p_display_name),p_role,p_active)
  on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active;
  delete from public.user_outlets where tenant_id=p_tenant_id and user_id=p_user_id;
  if p_role='OWNER' then
    insert into public.user_outlets(tenant_id,user_id,outlet_id)
    select p_tenant_id,p_user_id,id from public.outlets where tenant_id=p_tenant_id and active=true on conflict do nothing;
  else
    foreach v_outlet in array p_outlet_ids loop
      insert into public.user_outlets(tenant_id,user_id,outlet_id) values(p_tenant_id,p_user_id,v_outlet);
    end loop;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when v_was_existing then 'USER_ACCESS_UPDATED' else 'USER_CREATED' end,'profile',p_user_id,
    jsonb_build_object('displayName',trim(p_display_name),'role',p_role,'active',p_active,'outletIds',coalesce(p_outlet_ids,array[]::uuid[])));
  return jsonb_build_object('userId',p_user_id,'displayName',trim(p_display_name),'role',p_role,'active',p_active,
    'outletIds',(select coalesce(jsonb_agg(outlet_id),'[]') from public.user_outlets where user_id=p_user_id));
end $$;

revoke all on function public.request_stock_transfer_v1(uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.advance_stock_transfer_v1(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.save_outlet_price_override_v1(uuid,uuid,uuid,uuid,text,numeric,numeric,boolean) from public,anon,authenticated;
revoke all on function public.assign_promotion_outlets_v1(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.manage_profile_access(uuid,uuid,uuid,text,text,boolean,uuid[]) from public,anon,authenticated;
grant execute on function public.request_stock_transfer_v1(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.advance_stock_transfer_v1(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.save_outlet_price_override_v1(uuid,uuid,uuid,uuid,text,numeric,numeric,boolean) to service_role;
grant execute on function public.assign_promotion_outlets_v1(uuid,uuid,uuid,uuid[]) to service_role;
grant execute on function public.manage_profile_access(uuid,uuid,uuid,text,text,boolean,uuid[]) to service_role;
