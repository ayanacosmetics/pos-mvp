-- Kasir Nusa POS v1.23 - loyalty, member tiers, coded vouchers, and CRM.
alter table public.customers add column if not exists birth_date date;
alter table public.customers add column if not exists whatsapp_consent boolean not null default false;
alter table public.customers add column if not exists loyalty_points integer not null default 0;
alter table public.customers add column if not exists lifetime_spend numeric(19,4) not null default 0;
alter table public.customers add column if not exists last_purchase_at timestamptz;

create table if not exists public.loyalty_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default true,
  earn_amount_per_point numeric(19,4) not null default 10000 check(earn_amount_per_point>0),
  inactivity_days integer not null default 90 check(inactivity_days between 1 and 3650),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_tiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  min_lifetime_spend numeric(19,4) not null default 0 check(min_lifetime_spend>=0),
  points_multiplier numeric(8,4) not null default 1 check(points_multiplier>=0),
  color text not null default '#0f766e',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(tenant_id,code)
);

alter table public.customers add column if not exists tier_id uuid references public.customer_tiers(id);

create table if not exists public.customer_point_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  sale_id uuid references public.sales(id),
  entry_type text not null check(entry_type in ('EARN','REDEEM','ADJUST','EXPIRE','REVERSAL')),
  points integer not null check(points<>0),
  balance_after integer not null check(balance_after>=0),
  note text,
  actor_id uuid not null references public.profiles(user_id),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create table if not exists public.vouchers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id),
  code text not null,
  name text not null,
  discount_type text not null check(discount_type in ('FIXED','PERCENT')),
  discount_value numeric(19,4) not null check(discount_value>0),
  max_discount numeric(19,4),
  min_purchase numeric(19,4) not null default 0 check(min_purchase>=0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  usage_limit_total integer,
  usage_limit_per_customer integer,
  segment text not null default 'ALL' check(segment in ('ALL','ACTIVE','INACTIVE','HIGH_VALUE','BIRTHDAY')),
  one_time boolean not null default false,
  active boolean not null default true,
  usage_count integer not null default 0,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  unique(tenant_id,code),
  check(ends_at>starts_at),
  check(discount_type<>'PERCENT' or discount_value<=100)
);

create table if not exists public.voucher_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  voucher_id uuid not null references public.vouchers(id),
  customer_id uuid not null references public.customers(id),
  sale_id uuid not null references public.sales(id),
  outlet_id uuid not null references public.outlets(id),
  discount_amount numeric(19,4) not null check(discount_amount>0),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,sale_id)
);

alter table public.sales add column if not exists voucher_id uuid references public.vouchers(id);
alter table public.sales add column if not exists voucher_code text;
alter table public.sales add column if not exists voucher_discount numeric(19,4) not null default 0;
alter table public.sales add column if not exists points_earned integer not null default 0;

create index if not exists customer_points_history_idx on public.customer_point_entries(tenant_id,customer_id,occurred_at desc);
create index if not exists vouchers_lookup_idx on public.vouchers(tenant_id,upper(code),active,starts_at,ends_at);
create index if not exists voucher_customer_usage_idx on public.voucher_redemptions(tenant_id,voucher_id,customer_id);
create index if not exists customers_crm_idx on public.customers(tenant_id,last_purchase_at,lifetime_spend desc);

alter table public.loyalty_settings enable row level security;
alter table public.customer_tiers enable row level security;
alter table public.customer_point_entries enable row level security;
alter table public.vouchers enable row level security;
alter table public.voucher_redemptions enable row level security;

insert into public.loyalty_settings(tenant_id)
select id from public.tenants on conflict(tenant_id) do nothing;
insert into public.customer_tiers(tenant_id,code,name,min_lifetime_spend,points_multiplier,color)
select id,'MEMBER','Member',0,1,'#0f766e' from public.tenants on conflict(tenant_id,code) do nothing;
insert into public.customer_tiers(tenant_id,code,name,min_lifetime_spend,points_multiplier,color)
select id,'SILVER','Silver',1000000,1.25,'#64748b' from public.tenants on conflict(tenant_id,code) do nothing;
insert into public.customer_tiers(tenant_id,code,name,min_lifetime_spend,points_multiplier,color)
select id,'GOLD','Gold',5000000,1.5,'#b45309' from public.tenants on conflict(tenant_id,code) do nothing;
update public.customers c set tier_id=t.id
from public.customer_tiers t where t.tenant_id=c.tenant_id and t.code='MEMBER' and c.tier_id is null;

create or replace function public.create_default_loyalty_setup_v1() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  insert into public.loyalty_settings(tenant_id) values(new.id) on conflict do nothing;
  insert into public.customer_tiers(tenant_id,code,name,min_lifetime_spend,points_multiplier,color) values
    (new.id,'MEMBER','Member',0,1,'#0f766e'),
    (new.id,'SILVER','Silver',1000000,1.25,'#64748b'),
    (new.id,'GOLD','Gold',5000000,1.5,'#b45309')
  on conflict(tenant_id,code) do nothing;
  return new;
end $$;
drop trigger if exists tenants_default_loyalty_setup on public.tenants;
create trigger tenants_default_loyalty_setup after insert on public.tenants
for each row execute function public.create_default_loyalty_setup_v1();

create or replace function public.assign_default_customer_tier_v1() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.tier_id is null then
    select id into new.tier_id from public.customer_tiers
      where tenant_id=new.tenant_id and code='MEMBER' and active=true limit 1;
  end if;
  return new;
end $$;
drop trigger if exists customers_default_tier on public.customers;
create trigger customers_default_tier before insert on public.customers
for each row execute function public.assign_default_customer_tier_v1();

create or replace function public.save_customer_crm_profile_v1(
  p_tenant_id uuid,p_actor_id uuid,p_customer_id uuid,p_birth_date date,p_whatsapp_consent boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_customer public.customers%rowtype;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in ('OWNER','ADMIN','CASHIER'))
    then raise exception 'Akun tidak dapat mengelola pelanggan'; end if;
  update public.customers set birth_date=p_birth_date,whatsapp_consent=coalesce(p_whatsapp_consent,false),updated_at=now()
    where tenant_id=p_tenant_id and id=p_customer_id returning * into v_customer;
  if not found then raise exception 'Pelanggan tidak ditemukan'; end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'CUSTOMER_CRM_UPDATED','customer',p_customer_id,
    jsonb_build_object('birthDate',p_birth_date,'whatsappConsent',coalesce(p_whatsapp_consent,false)));
  return to_jsonb(v_customer);
end $$;

create or replace function public.quote_voucher_v1(
  p_tenant_id uuid,p_customer_id uuid,p_outlet_id uuid,p_code text,p_basket_total numeric
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_voucher public.vouchers%rowtype;v_customer public.customers%rowtype;v_settings public.loyalty_settings%rowtype;
  v_customer_usage integer;v_segment text;v_discount numeric;
begin
  if p_customer_id is null then raise exception 'Pilih member sebelum menggunakan voucher'; end if;
  select * into v_customer from public.customers where tenant_id=p_tenant_id and id=p_customer_id and active=true;
  if not found then raise exception 'Member tidak ditemukan atau tidak aktif'; end if;
  select * into v_voucher from public.vouchers
    where tenant_id=p_tenant_id and upper(code)=upper(trim(p_code)) limit 1;
  if not found or not v_voucher.active then raise exception 'Kode voucher tidak valid'; end if;
  if now()<v_voucher.starts_at then raise exception 'Voucher belum mulai berlaku'; end if;
  if now()>v_voucher.ends_at then raise exception 'Voucher sudah berakhir'; end if;
  if v_voucher.outlet_id is not null and v_voucher.outlet_id<>p_outlet_id then raise exception 'Voucher tidak berlaku di outlet ini'; end if;
  if p_basket_total<v_voucher.min_purchase then raise exception 'Minimal belanja voucher belum terpenuhi'; end if;
  if v_voucher.usage_limit_total is not null and v_voucher.usage_count>=v_voucher.usage_limit_total then raise exception 'Kuota voucher sudah habis'; end if;
  select count(*) into v_customer_usage from public.voucher_redemptions
    where tenant_id=p_tenant_id and voucher_id=v_voucher.id and customer_id=p_customer_id;
  if v_voucher.one_time and v_customer_usage>0 then raise exception 'Voucher satu kali ini sudah pernah digunakan'; end if;
  if v_voucher.usage_limit_per_customer is not null and v_customer_usage>=v_voucher.usage_limit_per_customer then raise exception 'Batas voucher untuk member ini sudah tercapai'; end if;
  select * into v_settings from public.loyalty_settings where tenant_id=p_tenant_id;
  if to_char(v_customer.birth_date,'MM-DD')=to_char(current_date,'MM-DD') then v_segment:='BIRTHDAY';
  elsif v_customer.lifetime_spend>=5000000 then v_segment:='HIGH_VALUE';
  elsif v_customer.last_purchase_at is null or v_customer.last_purchase_at<now()-make_interval(days=>coalesce(v_settings.inactivity_days,90)) then v_segment:='INACTIVE';
  else v_segment:='ACTIVE'; end if;
  if v_voucher.segment<>'ALL' and v_voucher.segment<>v_segment then raise exception 'Voucher tidak berlaku untuk segmen member ini'; end if;
  v_discount:=case when v_voucher.discount_type='PERCENT'
    then p_basket_total*v_voucher.discount_value/100 else v_voucher.discount_value end;
  if v_voucher.max_discount is not null then v_discount:=least(v_discount,v_voucher.max_discount); end if;
  v_discount:=round(least(v_discount,p_basket_total),2);
  return jsonb_build_object('id',v_voucher.id,'code',v_voucher.code,'name',v_voucher.name,
    'discount',v_discount,'segment',v_segment);
end $$;

create or replace function public.complete_sale_v7(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_shift_id uuid,p_customer_id uuid,p_customer_group_id text,p_payments jsonb,p_quote jsonb,
  p_authorization_id uuid,p_basket_fingerprint text,p_notes text,p_voucher_code text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;v_sale_id uuid;v_voucher jsonb;v_discount numeric:=0;v_existing public.sales%rowtype;
  v_customer public.customers%rowtype;v_tier public.customer_tiers%rowtype;v_settings public.loyalty_settings%rowtype;
  v_points integer:=0;v_balance integer:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    select * into v_customer from public.customers where id=v_existing.customer_id;
    select * into v_tier from public.customer_tiers where id=v_customer.tier_id;
    return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,
      'duplicate',true,'change',0,'notes',v_existing.notes,'pointsEarned',v_existing.points_earned,
      'pointsBalance',coalesce(v_customer.loyalty_points,0),'tierName',v_tier.name);
  end if;
  if nullif(trim(coalesce(p_voucher_code,'')),'') is not null then
    perform 1 from public.vouchers where tenant_id=p_tenant_id and upper(code)=upper(trim(p_voucher_code)) for update;
    v_voucher:=public.quote_voucher_v1(p_tenant_id,p_customer_id,p_outlet_id,p_voucher_code,
      (p_quote->>'grandTotal')::numeric+coalesce((p_quote->'voucher'->>'discount')::numeric,0));
    v_discount:=(v_voucher->>'discount')::numeric;
    if abs(v_discount-coalesce((p_quote->'voucher'->>'discount')::numeric,0))>0.01 then raise exception 'Nilai voucher berubah; perbarui total transaksi'; end if;
  elsif p_quote ? 'voucher' then raise exception 'Kode voucher wajib dikirim'; end if;
  v_result:=public.complete_sale_v6(p_tenant_id,p_actor_id,p_idempotency_key,p_outlet_id,p_shift_id,
    p_customer_id,p_customer_group_id,p_payments,p_quote,p_authorization_id,p_basket_fingerprint,p_notes);
  v_sale_id:=(v_result->>'id')::uuid;
  if p_customer_id is not null then
    update public.customers set lifetime_spend=lifetime_spend+(p_quote->>'grandTotal')::numeric,last_purchase_at=now()
      where tenant_id=p_tenant_id and id=p_customer_id returning * into v_customer;
    select * into v_tier from public.customer_tiers where tenant_id=p_tenant_id and active=true
      and min_lifetime_spend<=v_customer.lifetime_spend order by min_lifetime_spend desc limit 1;
    update public.customers set tier_id=v_tier.id where id=p_customer_id;
    select * into v_settings from public.loyalty_settings where tenant_id=p_tenant_id;
    if coalesce(v_settings.enabled,true) then
      v_points:=floor(((p_quote->>'grandTotal')::numeric/coalesce(v_settings.earn_amount_per_point,10000))*coalesce(v_tier.points_multiplier,1));
      if v_points>0 then
        update public.customers set loyalty_points=loyalty_points+v_points where id=p_customer_id returning loyalty_points into v_balance;
        insert into public.customer_point_entries(tenant_id,customer_id,sale_id,entry_type,points,balance_after,note,actor_id,idempotency_key)
        values(p_tenant_id,p_customer_id,v_sale_id,'EARN',v_points,v_balance,'Poin dari transaksi',p_actor_id,'SALE:'||v_sale_id::text);
      else v_balance:=v_customer.loyalty_points; end if;
    end if;
  end if;
  if v_voucher is not null then
    insert into public.voucher_redemptions(tenant_id,voucher_id,customer_id,sale_id,outlet_id,discount_amount)
    values(p_tenant_id,(v_voucher->>'id')::uuid,p_customer_id,v_sale_id,p_outlet_id,v_discount);
    update public.vouchers set usage_count=usage_count+1 where id=(v_voucher->>'id')::uuid;
  end if;
  update public.sales set voucher_id=(v_voucher->>'id')::uuid,voucher_code=v_voucher->>'code',
    voucher_discount=v_discount,points_earned=v_points where id=v_sale_id;
  return v_result||jsonb_build_object('pointsEarned',v_points,'pointsBalance',v_balance,
    'tierName',v_tier.name,'voucher',v_voucher);
end $$;

create or replace function public.void_sale_v2(
  p_tenant_id uuid,p_actor_id uuid,p_approved_by uuid,p_sale_id uuid,p_outlet_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_sale public.sales%rowtype;v_result jsonb;v_balance integer;
begin
  select * into v_sale from public.sales where tenant_id=p_tenant_id and id=p_sale_id for update;
  v_result:=public.void_sale_v1(p_tenant_id,p_actor_id,p_approved_by,p_sale_id,p_outlet_id,p_reason);
  if coalesce((v_result->>'duplicate')::boolean,false)=false then
    if v_sale.customer_id is not null then
      update public.customers set lifetime_spend=greatest(0,lifetime_spend-v_sale.grand_total),
        loyalty_points=greatest(0,loyalty_points-v_sale.points_earned)
        where id=v_sale.customer_id returning loyalty_points into v_balance;
      if v_sale.points_earned>0 then
        insert into public.customer_point_entries(tenant_id,customer_id,sale_id,entry_type,points,balance_after,note,actor_id,idempotency_key)
        values(p_tenant_id,v_sale.customer_id,v_sale.id,'REVERSAL',-v_sale.points_earned,v_balance,'Pembalikan void',p_actor_id,'VOID:'||v_sale.id::text);
      end if;
    end if;
    if v_sale.voucher_id is not null then
      delete from public.voucher_redemptions where tenant_id=p_tenant_id and sale_id=v_sale.id;
      update public.vouchers set usage_count=greatest(0,usage_count-1) where id=v_sale.voucher_id;
    end if;
  end if;
  return v_result;
end $$;

revoke all on function public.save_customer_crm_profile_v1(uuid,uuid,uuid,date,boolean) from public,anon,authenticated;
revoke all on function public.quote_voucher_v1(uuid,uuid,uuid,text,numeric) from public,anon,authenticated;
revoke all on function public.complete_sale_v7(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.void_sale_v2(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.create_default_loyalty_setup_v1() from public,anon,authenticated;
revoke all on function public.assign_default_customer_tier_v1() from public,anon,authenticated;
grant execute on function public.save_customer_crm_profile_v1(uuid,uuid,uuid,date,boolean) to service_role;
grant execute on function public.quote_voucher_v1(uuid,uuid,uuid,text,numeric) to service_role;
grant execute on function public.complete_sale_v7(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text,text,text) to service_role;
grant execute on function public.void_sale_v2(uuid,uuid,uuid,uuid,uuid,text) to service_role;
