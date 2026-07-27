-- Kasir Nusa POS v2.5.0 - tipe pelanggan dan harga produk terintegrasi

create table if not exists public.customer_price_groups (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null,
  name text not null,
  is_default boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,id),
  check(id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  check(length(trim(name)) between 2 and 50)
);

create unique index if not exists customer_price_groups_name_key
  on public.customer_price_groups(tenant_id,lower(name));

insert into public.customer_price_groups(tenant_id,id,name,is_default,sort_order)
select id,'retail','Eceran',true,0 from public.tenants
on conflict(tenant_id,id) do update set name='Eceran',is_default=true,active=true,sort_order=0;

insert into public.customer_price_groups(tenant_id,id,name,sort_order)
select id,'member','Member',10 from public.tenants
on conflict(tenant_id,id) do nothing;

insert into public.customer_price_groups(tenant_id,id,name,sort_order)
select id,'wholesale','Grosir',20 from public.tenants
on conflict(tenant_id,id) do nothing;

create or replace function public.seed_customer_price_groups()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.customer_price_groups(tenant_id,id,name,is_default,sort_order)
  values
    (new.id,'retail','Eceran',true,0),
    (new.id,'member','Member',false,10),
    (new.id,'wholesale','Grosir',false,20)
  on conflict(tenant_id,id) do nothing;
  return new;
end $$;

drop trigger if exists tenants_seed_customer_price_groups on public.tenants;
create trigger tenants_seed_customer_price_groups
after insert on public.tenants
for each row execute function public.seed_customer_price_groups();

alter table public.customers drop constraint if exists customers_group_id_check;
alter table public.customers drop constraint if exists customers_group_reference;
alter table public.customers add constraint customers_group_reference
  foreign key(tenant_id,group_id)
  references public.customer_price_groups(tenant_id,id);

alter table public.price_rules drop constraint if exists price_rules_customer_group_id_check;
alter table public.price_rules drop constraint if exists price_rules_group_reference;
alter table public.price_rules add constraint price_rules_group_reference
  foreign key(tenant_id,customer_group_id)
  references public.customer_price_groups(tenant_id,id);

alter table public.outlet_price_overrides
  drop constraint if exists outlet_price_overrides_customer_group_id_check;
alter table public.outlet_price_overrides
  drop constraint if exists outlet_price_overrides_group_reference;
alter table public.outlet_price_overrides
  add constraint outlet_price_overrides_group_reference
  foreign key(tenant_id,customer_group_id)
  references public.customer_price_groups(tenant_id,id);

alter table public.customer_price_groups enable row level security;
revoke all on table public.customer_price_groups from anon,authenticated;
grant all on table public.customer_price_groups to service_role;

create or replace function public.save_customer_profile(
  p_tenant_id uuid,p_actor_id uuid,p_customer_id uuid,p_name text,p_phone text,p_email text,
  p_address text,p_group_id text,p_credit_enabled boolean,p_credit_limit numeric,
  p_credit_days integer,p_notes text,p_active boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype; v_customer public.customers%rowtype; v_seq bigint;
  v_enable boolean:=coalesce(p_credit_enabled,false); v_limit numeric:=coalesce(p_credit_limit,0);
  v_group_id text:=coalesce(nullif(trim(p_group_id),''),'retail');
begin
  select * into v_actor from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true;
  if not found or v_actor.role not in ('OWNER','ADMIN','CASHIER') then raise exception 'Akun tidak dapat mengelola pelanggan'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama pelanggan wajib diisi'; end if;
  if not exists(
    select 1 from public.customer_price_groups
    where tenant_id=p_tenant_id and id=v_group_id and active=true
  ) then raise exception 'Tipe pelanggan tidak valid atau sudah nonaktif'; end if;
  if v_limit<0 or coalesce(p_credit_days,0) not between 0 and 365 then raise exception 'Batas atau tempo kredit tidak valid'; end if;
  if v_actor.role='CASHIER' and (v_enable or v_limit>0) then raise exception 'Hanya Owner atau Admin yang dapat mengaktifkan kredit'; end if;
  if v_enable and v_limit<=0 then raise exception 'Batas kredit harus lebih dari nol'; end if;

  if p_customer_id is null then
    insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'CUSTOMER',2)
    on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1
    returning next_value-1 into v_seq;
    insert into public.customers(
      tenant_id,code,name,phone,email,address,group_id,credit_enabled,credit_limit,credit_days,notes,active
    ) values(
      p_tenant_id,'PLG-'||lpad(v_seq::text,5,'0'),trim(p_name),nullif(trim(p_phone),''),
      nullif(lower(trim(p_email)),''),nullif(trim(p_address),''),v_group_id,v_enable,v_limit,
      coalesce(p_credit_days,0),nullif(trim(p_notes),''),coalesce(p_active,true)
    ) returning * into v_customer;
  else
    if v_actor.role='CASHIER' then raise exception 'Hanya Owner atau Admin yang dapat mengubah profil pelanggan'; end if;
    update public.customers set
      name=trim(p_name),phone=nullif(trim(p_phone),''),email=nullif(lower(trim(p_email)),''),
      address=nullif(trim(p_address),''),group_id=v_group_id,credit_enabled=v_enable,
      credit_limit=v_limit,credit_days=coalesce(p_credit_days,0),notes=nullif(trim(p_notes),''),
      active=coalesce(p_active,true),updated_at=now()
    where id=p_customer_id and tenant_id=p_tenant_id returning * into v_customer;
    if not found then raise exception 'Pelanggan tidak ditemukan'; end if;
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when p_customer_id is null then 'CUSTOMER_CREATED' else 'CUSTOMER_UPDATED' end,
    'customer',v_customer.id,jsonb_build_object('code',v_customer.code,'groupId',v_customer.group_id,
    'creditEnabled',v_customer.credit_enabled,'creditLimit',v_customer.credit_limit,'creditDays',v_customer.credit_days));
  return to_jsonb(v_customer);
end $$;

create or replace function public.save_product_v4(
  p_tenant_id uuid,p_actor_id uuid,p_product jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb; v_product_id uuid; v_price jsonb; v_group_id text;
  v_amount numeric; v_seen text[]:=array[]::text[]; v_has_retail boolean:=false;
begin
  v_result:=public.save_product_v3(
    p_tenant_id,p_actor_id,p_product||jsonb_build_object('wholesalePrice',0)
  );
  v_product_id:=(v_result->>'id')::uuid;

  if coalesce(jsonb_typeof(p_product->'prices'),'')<>'array' then
    return v_result;
  end if;

  delete from public.price_rules
  where tenant_id=p_tenant_id and product_id=v_product_id
    and starts_at is null and ends_at is null;

  for v_price in select value from jsonb_array_elements(p_product->'prices') loop
    v_group_id:=nullif(trim(v_price->>'customerGroupId'),'');
    v_amount:=(v_price->>'unitPriceBase')::numeric;
    if v_group_id is null or v_amount<=0 then raise exception 'Tipe dan nominal harga produk tidak valid'; end if;
    if v_group_id=any(v_seen) then raise exception 'Tipe harga produk tercatat dua kali'; end if;
    if not exists(
      select 1 from public.customer_price_groups
      where tenant_id=p_tenant_id and id=v_group_id and active=true
    ) then raise exception 'Tipe pelanggan % tidak valid atau sudah nonaktif',v_group_id; end if;
    v_seen:=array_append(v_seen,v_group_id);
    v_has_retail:=v_has_retail or v_group_id='retail';
    insert into public.price_rules(
      tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority
    ) values(
      p_tenant_id,v_product_id,v_group_id,1,v_amount,
      case when v_group_id='retail' then 10 else 20+coalesce(array_length(v_seen,1),0) end
    );
  end loop;
  if not v_has_retail then raise exception 'Harga umum produk wajib diisi'; end if;

  if coalesce((p_product->>'tierQty')::numeric,0)>1
    and coalesce((p_product->>'tierPrice')::numeric,0)>0 then
    insert into public.price_rules(
      tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority
    ) values(
      p_tenant_id,v_product_id,null,(p_product->>'tierQty')::numeric,
      (p_product->>'tierPrice')::numeric,30
    );
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'PRODUCT_CUSTOMER_PRICES_UPDATED','product',v_product_id,
    jsonb_build_object('prices',p_product->'prices')
  );
  return v_result||jsonb_build_object('priceCount',jsonb_array_length(p_product->'prices'));
end $$;

revoke all on function public.save_product_v4(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_product_v4(uuid,uuid,jsonb)
  to service_role;
