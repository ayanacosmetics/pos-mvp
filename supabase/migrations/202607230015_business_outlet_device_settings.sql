-- Kasir Nusa POS - business, outlet, stock location, device and receipt settings

alter table public.tenants add column if not exists legal_name text;
alter table public.tenants add column if not exists phone text;
alter table public.tenants add column if not exists email text;
alter table public.tenants add column if not exists address text;
alter table public.tenants add column if not exists tax_id text;
alter table public.tenants add column if not exists currency text not null default 'IDR';
alter table public.tenants add column if not exists receipt_footer text not null default 'Terima kasih telah berbelanja.';
alter table public.tenants add column if not exists logo_url text;
alter table public.tenants add column if not exists updated_at timestamptz not null default now();

alter table public.outlets add column if not exists phone text;
alter table public.outlets add column if not exists address text;
alter table public.outlets add column if not exists receipt_prefix text;
alter table public.outlets add column if not exists receipt_footer text;
alter table public.outlets add column if not exists updated_at timestamptz not null default now();
update public.outlets set receipt_prefix=upper(code) where receipt_prefix is null or trim(receipt_prefix)='';
alter table public.outlets alter column receipt_prefix set not null;
create unique index if not exists outlets_receipt_prefix_unique on public.outlets(tenant_id,receipt_prefix);

alter table public.stock_locations add column if not exists active boolean not null default true;
alter table public.stock_locations add column if not exists updated_at timestamptz not null default now();

alter table public.pos_devices add column if not exists paper_width integer not null default 80;
alter table public.pos_devices add column if not exists auto_print boolean not null default false;
alter table public.pos_devices add column if not exists receipt_copies integer not null default 1;
alter table public.pos_devices add column if not exists updated_at timestamptz not null default now();

create or replace function public.save_business_settings(
  p_tenant_id uuid, p_actor_id uuid, p_name text, p_legal_name text, p_phone text,
  p_email text, p_address text, p_tax_id text, p_receipt_footer text, p_logo_url text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_result public.tenants%rowtype;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then raise exception 'Hanya Owner yang dapat mengubah identitas usaha'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama usaha wajib diisi'; end if;
  update public.tenants set
    name=trim(p_name), legal_name=nullif(trim(p_legal_name),''),
    phone=nullif(trim(p_phone),''), email=nullif(lower(trim(p_email)),''),
    address=nullif(trim(p_address),''), tax_id=nullif(trim(p_tax_id),''),
    receipt_footer=coalesce(nullif(trim(p_receipt_footer),''),'Terima kasih telah berbelanja.'),
    logo_url=nullif(trim(p_logo_url),''), updated_at=now()
  where id=p_tenant_id returning * into v_result;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'BUSINESS_SETTINGS_UPDATED','tenant',p_tenant_id,jsonb_build_object('name',v_result.name));
  return to_jsonb(v_result);
end $$;

create or replace function public.save_outlet_settings(
  p_tenant_id uuid, p_actor_id uuid, p_outlet_id uuid, p_code text, p_name text,
  p_phone text, p_address text, p_timezone text, p_receipt_prefix text,
  p_receipt_footer text, p_active boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_outlet public.outlets%rowtype; v_id uuid; v_code text; v_prefix text;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then raise exception 'Hanya Owner yang dapat mengubah outlet'; end if;
  v_code:=upper(regexp_replace(trim(coalesce(p_code,'')),'[^A-Za-z0-9]','','g'));
  v_prefix:=upper(regexp_replace(trim(coalesce(p_receipt_prefix,'')),'[^A-Za-z0-9]','','g'));
  if v_code='' or length(v_code)>10 then raise exception 'Kode outlet wajib 1-10 huruf atau angka'; end if;
  if v_prefix='' or length(v_prefix)>10 then raise exception 'Awalan struk wajib 1-10 huruf atau angka'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama outlet wajib diisi'; end if;
  if coalesce(trim(p_timezone),'')='' then raise exception 'Zona waktu wajib diisi'; end if;
  if p_outlet_id is null then
    insert into public.outlets(tenant_id,code,name,phone,address,timezone,receipt_prefix,receipt_footer,active,updated_at)
    values(p_tenant_id,v_code,trim(p_name),nullif(trim(p_phone),''),nullif(trim(p_address),''),
      trim(p_timezone),v_prefix,nullif(trim(p_receipt_footer),''),coalesce(p_active,true),now())
    returning * into v_outlet;
    v_id:=v_outlet.id;
    insert into public.stock_locations(tenant_id,outlet_id,code,name,kind)
    values(p_tenant_id,v_id,v_code||'-TOKO',trim(p_name),'STORE');
    insert into public.stock_locations(tenant_id,outlet_id,code,name,kind)
    values(p_tenant_id,v_id,v_code||'-GDG','Gudang '||trim(p_name),'WAREHOUSE');
  else
    select * into v_outlet from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Outlet tidak ditemukan'; end if;
    if coalesce(p_active,true)=false and v_outlet.active=true
      and (select count(*) from public.outlets where tenant_id=p_tenant_id and active=true)=1
    then raise exception 'Minimal satu outlet harus tetap aktif'; end if;
    update public.outlets set code=v_code,name=trim(p_name),phone=nullif(trim(p_phone),''),
      address=nullif(trim(p_address),''),timezone=trim(p_timezone),receipt_prefix=v_prefix,
      receipt_footer=nullif(trim(p_receipt_footer),''),active=coalesce(p_active,true),updated_at=now()
    where id=p_outlet_id returning * into v_outlet;
    v_id:=p_outlet_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when p_outlet_id is null then 'OUTLET_CREATED' else 'OUTLET_UPDATED' end,
    'outlet',v_id,jsonb_build_object('code',v_code,'name',trim(p_name),'active',coalesce(p_active,true)));
  return to_jsonb(v_outlet);
end $$;

create or replace function public.save_stock_location_settings(
  p_tenant_id uuid, p_actor_id uuid, p_location_id uuid, p_outlet_id uuid,
  p_code text, p_name text, p_kind text, p_active boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_location public.stock_locations%rowtype; v_id uuid; v_code text; v_kind text;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then raise exception 'Hanya Owner yang dapat mengubah lokasi stok'; end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id) then raise exception 'Outlet tidak ditemukan'; end if;
  v_code:=upper(regexp_replace(trim(coalesce(p_code,'')),'[^A-Za-z0-9-]','','g'));
  v_kind:=upper(trim(coalesce(p_kind,'')));
  if v_code='' or length(v_code)>20 then raise exception 'Kode lokasi wajib 1-20 huruf, angka, atau tanda hubung'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama lokasi wajib diisi'; end if;
  if v_kind not in ('STORE','WAREHOUSE','TRANSIT') then raise exception 'Jenis lokasi tidak valid'; end if;
  if p_location_id is null then
    insert into public.stock_locations(tenant_id,outlet_id,code,name,kind,active,updated_at)
    values(p_tenant_id,p_outlet_id,v_code,trim(p_name),v_kind,coalesce(p_active,true),now())
    returning * into v_location; v_id:=v_location.id;
  else
    select * into v_location from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Lokasi stok tidak ditemukan'; end if;
    if coalesce(p_active,true)=false and exists(
      select 1 from public.stock_balances where tenant_id=p_tenant_id and location_id=p_location_id and quantity<>0
    ) then raise exception 'Lokasi dengan stok tidak nol tidak dapat dinonaktifkan'; end if;
    if coalesce(p_active,true)=false and v_location.kind='STORE'
      and exists(select 1 from public.outlets where id=v_location.outlet_id and active=true)
    then raise exception 'Lokasi toko utama pada outlet aktif tidak dapat dinonaktifkan'; end if;
    update public.stock_locations set outlet_id=p_outlet_id,code=v_code,name=trim(p_name),kind=v_kind,
      active=coalesce(p_active,true),updated_at=now() where id=p_location_id returning * into v_location;
    v_id:=p_location_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when p_location_id is null then 'STOCK_LOCATION_CREATED' else 'STOCK_LOCATION_UPDATED' end,
    'stock_location',v_id,jsonb_build_object('code',v_code,'name',trim(p_name),'kind',v_kind,'active',coalesce(p_active,true)));
  return to_jsonb(v_location);
end $$;

create or replace function public.save_pos_device_settings(
  p_tenant_id uuid, p_actor_id uuid, p_device_id uuid, p_outlet_id uuid,
  p_name text, p_platform text, p_paper_width integer, p_auto_print boolean, p_receipt_copies integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_device public.pos_devices%rowtype;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then raise exception 'Hanya Owner yang dapat mengubah perangkat kasir'; end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true) then raise exception 'Outlet perangkat tidak valid'; end if;
  if p_paper_width not in (58,80) then raise exception 'Ukuran kertas harus 58 mm atau 80 mm'; end if;
  if p_receipt_copies<1 or p_receipt_copies>3 then raise exception 'Jumlah salinan struk harus 1 sampai 3'; end if;
  insert into public.pos_devices(id,tenant_id,outlet_id,name,platform,active,created_by,paper_width,auto_print,receipt_copies,last_seen_at,updated_at)
  values(p_device_id,p_tenant_id,p_outlet_id,coalesce(nullif(trim(p_name),''),'Perangkat POS'),nullif(trim(p_platform),''),
    true,p_actor_id,p_paper_width,coalesce(p_auto_print,false),p_receipt_copies,now(),now())
  on conflict(id) do update set outlet_id=excluded.outlet_id,name=excluded.name,platform=excluded.platform,
    paper_width=excluded.paper_width,auto_print=excluded.auto_print,receipt_copies=excluded.receipt_copies,
    active=true,last_seen_at=now(),updated_at=now()
  where public.pos_devices.tenant_id=excluded.tenant_id
  returning * into v_device;
  if v_device.id is null then raise exception 'Perangkat terdaftar pada usaha yang berbeda'; end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'POS_DEVICE_CONFIGURED','pos_device',p_device_id,
    jsonb_build_object('name',v_device.name,'outletId',v_device.outlet_id,'paperWidth',v_device.paper_width));
  return to_jsonb(v_device);
end $$;

create or replace function public.complete_sale_v3(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_outlet_id uuid,
  p_shift_id uuid, p_customer_id uuid, p_customer_group_id text, p_payments jsonb, p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid; v_existing public.sales%rowtype; v_location uuid; v_line jsonb; v_payment jsonb;
  v_balance public.stock_balances%rowtype; v_outlet public.outlets%rowtype; v_cost numeric:=0;
  v_line_cost numeric; v_seq bigint; v_receipt text; v_due numeric:=(p_quote->>'grandTotal')::numeric;
  v_paid numeric:=0; v_tendered numeric; v_amount numeric; v_change numeric:=0; v_method text;
  v_payment_count integer:=0; v_payment_label text; v_line_index integer:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true,'change',0); end if;
  select * into v_outlet from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true;
  if not found then raise exception 'Outlet transaksi tidak aktif'; end if;
  if not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN') then raise exception 'Shift kasir belum dibuka'; end if;
  if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'Pembayaran wajib diisi'; end if;
  if jsonb_array_length(p_payments)>4 then raise exception 'Maksimal empat metode pembayaran'; end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method')); v_amount:=coalesce((v_payment->>'amount')::numeric,0);
    if v_method not in ('CASH','QRIS','TRANSFER','EDC') then raise exception 'Metode pembayaran % tidak valid',v_method; end if;
    if v_amount<=0 then raise exception 'Jumlah pembayaran harus lebih dari nol'; end if;
    v_paid:=v_paid+v_amount; v_payment_count:=v_payment_count+1;
    if v_method='CASH' then
      v_tendered:=coalesce((v_payment->>'tendered')::numeric,v_amount);
      if v_tendered<v_amount then raise exception 'Uang tunai diterima kurang dari bagian tunai'; end if;
      v_change:=v_change+(v_tendered-v_amount);
    end if;
  end loop;
  if abs(v_paid-v_due)>0.01 then raise exception 'Total pembayaran % tidak sama dengan total transaksi %',v_paid,v_due; end if;
  select id into v_location from public.stock_locations
    where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' and active=true order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko aktif tidak ditemukan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE:'||p_outlet_id::text,2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:=v_outlet.receipt_prefix||'-'||lpad(v_seq::text,6,'0');
  if v_payment_count>1 then v_payment_label:='Gabungan';
  else v_payment_label:=case upper(p_payments->0->>'method') when 'CASH' then 'Tunai' when 'QRIS' then 'QRIS' when 'TRANSFER' then 'Transfer' else 'EDC' end; end if;
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,
    (p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,v_due,0,v_payment_label) returning id into v_sale;
  for v_line in select value from jsonb_array_elements(p_quote->'lines') loop
    v_line_index:=v_line_index+1;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=(v_line->>'productId')::uuid for update;
    if not found or v_balance.quantity<(v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName'; end if;
    v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric; v_cost:=v_cost+v_line_cost;
    update public.stock_balances set quantity=quantity-(v_line->>'baseQty')::numeric,version=version+1,updated_at=now()
      where location_id=v_location and product_id=(v_line->>'productId')::uuid;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key)
    values(p_tenant_id,v_location,(v_line->>'productId')::uuid,-(v_line->>'baseQty')::numeric,v_balance.quantity-(v_line->>'baseQty')::numeric,
      v_balance.avg_cost,'SALE',v_sale,p_actor_id,p_idempotency_key||':stock:'||v_line_index);
    insert into public.sale_items(tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,pricing_snapshot,promotion_snapshot)
    values(p_tenant_id,v_sale,(v_line->>'productId')::uuid,v_line->>'productName',(v_line->>'baseQty')::numeric,(v_line->>'gross')::numeric,
      (v_line->>'discount')::numeric,(v_line->>'total')::numeric,v_line_cost,
      jsonb_build_object('priceRuleId',v_line->>'priceRuleId','unitName',v_line->>'unitName','qty',v_line->>'qty'),coalesce(v_line->'promotions','[]'));
  end loop;
  update public.sales set cost_total=v_cost where id=v_sale;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method')); v_amount:=(v_payment->>'amount')::numeric;
    v_tendered:=case when v_method='CASH' then coalesce((v_payment->>'tendered')::numeric,v_amount) else null end;
    insert into public.payments(tenant_id,sale_id,method,amount,reference,tendered_amount,change_amount)
    values(p_tenant_id,v_sale,v_method,v_amount,nullif(trim(v_payment->>'reference'),''),v_tendered,
      case when v_method='CASH' then v_tendered-v_amount else 0 end);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,
    jsonb_build_object('receiptNo',v_receipt,'grandTotal',v_due,'paymentCount',v_payment_count,'change',v_change,'outletPrefix',v_outlet.receipt_prefix));
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false,'change',v_change,'payments',p_payments);
end $$;

revoke all on function public.save_business_settings(uuid,uuid,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.save_outlet_settings(uuid,uuid,uuid,text,text,text,text,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.save_stock_location_settings(uuid,uuid,uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.save_pos_device_settings(uuid,uuid,uuid,uuid,text,text,integer,boolean,integer) from public,anon,authenticated;
revoke all on function public.complete_sale_v3(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_business_settings(uuid,uuid,text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.save_outlet_settings(uuid,uuid,uuid,text,text,text,text,text,text,text,boolean) to service_role;
grant execute on function public.save_stock_location_settings(uuid,uuid,uuid,uuid,text,text,text,boolean) to service_role;
grant execute on function public.save_pos_device_settings(uuid,uuid,uuid,uuid,text,text,integer,boolean,integer) to service_role;
grant execute on function public.complete_sale_v3(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) to service_role;
