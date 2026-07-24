-- Kasir Nusa POS - advanced deterministic promotion engine and usage enforcement

alter table public.promotion_versions add column if not exists usage_limit_total integer;
alter table public.promotion_versions add column if not exists usage_limit_per_customer integer;
alter table public.promotion_versions add column if not exists usage_count integer not null default 0;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='promotion_usage_total_positive') then
    alter table public.promotion_versions add constraint promotion_usage_total_positive
      check(usage_limit_total is null or usage_limit_total>0) not valid;
  end if;
  if not exists(select 1 from pg_constraint where conname='promotion_usage_customer_positive') then
    alter table public.promotion_versions add constraint promotion_usage_customer_positive
      check(usage_limit_per_customer is null or usage_limit_per_customer>0) not valid;
  end if;
end $$;

create table if not exists public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  promotion_version_id uuid not null references public.promotion_versions(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  customer_id uuid references public.customers(id),
  discount_amount numeric(19,4) not null default 0,
  redeemed_at timestamptz not null default now(),
  unique(promotion_version_id,sale_id)
);
alter table public.promotion_redemptions enable row level security;
drop policy if exists tenant_isolation on public.promotion_redemptions;
create policy tenant_isolation on public.promotion_redemptions for select to authenticated
  using(tenant_id=public.current_tenant_id());
grant select on public.promotion_redemptions to authenticated;
grant select,insert,update on public.promotion_redemptions to service_role;
create index if not exists promotion_redemptions_total_idx on public.promotion_redemptions(promotion_version_id,redeemed_at);
create index if not exists promotion_redemptions_customer_idx on public.promotion_redemptions(promotion_version_id,customer_id,redeemed_at);

create or replace function public.publish_promotion_v2(
  p_tenant_id uuid, p_actor_id uuid, p_rule jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype; v_promotion uuid; v_version integer; v_version_id uuid;
  v_code text; v_name text; v_type text; v_condition jsonb; v_reward jsonb;
  v_starts timestamptz; v_ends timestamptz; v_total integer; v_per_customer integer;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role not in ('OWNER','ADMIN') then raise exception 'Akun tidak dapat menerbitkan promo'; end if;
  v_code:=upper(regexp_replace(trim(coalesce(p_rule->>'code','')),'[^A-Za-z0-9_-]','','g'));
  v_name:=trim(coalesce(p_rule->>'name',''));
  v_condition:=coalesce(p_rule->'condition','{}'::jsonb);
  v_reward:=coalesce(p_rule->'reward','{}'::jsonb);
  v_type:=upper(coalesce(v_reward->>'type',''));
  v_starts:=(p_rule->>'startsAt')::timestamptz; v_ends:=(p_rule->>'endsAt')::timestamptz;
  v_total:=nullif(p_rule->>'usageLimitTotal','')::integer;
  v_per_customer:=nullif(p_rule->>'usageLimitPerCustomer','')::integer;
  if v_code='' or length(v_code)>30 then raise exception 'Kode promo wajib 1-30 huruf atau angka'; end if;
  if v_name='' then raise exception 'Nama promo wajib diisi'; end if;
  if v_ends<=v_starts then raise exception 'Waktu selesai promo harus setelah waktu mulai'; end if;
  if v_type not in ('PERCENT_ITEM','FIXED_ITEM','SPECIAL_PRICE','PERCENT_ORDER','BUY_X_GET_Y','BUNDLE_FIXED') then raise exception 'Jenis promo tidak valid'; end if;
  if v_type in ('PERCENT_ITEM','FIXED_ITEM','SPECIAL_PRICE','PERCENT_ORDER','BUNDLE_FIXED')
    and coalesce((v_reward->>'value')::numeric,0)<=0 then raise exception 'Nilai promo harus lebih dari nol'; end if;
  if v_type in ('PERCENT_ITEM','PERCENT_ORDER') and (v_reward->>'value')::numeric>100 then raise exception 'Diskon persen maksimal 100'; end if;
  if v_type='BUY_X_GET_Y' and (coalesce((v_reward->>'buyQty')::numeric,0)<=0 or coalesce((v_reward->>'freeQty')::numeric,0)<=0)
    then raise exception 'Jumlah beli dan gratis harus lebih dari nol'; end if;
  if v_type='BUNDLE_FIXED' and jsonb_array_length(coalesce(v_condition->'bundle','[]'::jsonb))<2
    then raise exception 'Paket bundling minimal berisi dua produk'; end if;
  if v_total is not null and v_total<=0 then raise exception 'Batas total pemakaian harus lebih dari nol'; end if;
  if v_per_customer is not null and v_per_customer<=0 then raise exception 'Batas per pelanggan harus lebih dari nol'; end if;

  select id into v_promotion from public.promotions where tenant_id=p_tenant_id and code=v_code for update;
  if v_promotion is null then
    insert into public.promotions(tenant_id,code,name) values(p_tenant_id,v_code,v_name) returning id into v_promotion;
  else update public.promotions set name=v_name where id=v_promotion;
  end if;
  select coalesce(max(version),0)+1 into v_version from public.promotion_versions where promotion_id=v_promotion;
  update public.promotion_versions set status='RETIRED' where promotion_id=v_promotion and status='PUBLISHED';
  insert into public.promotion_versions(
    tenant_id,promotion_id,version,status,priority,stackable,starts_at,ends_at,rule_json,published_at,
    usage_limit_total,usage_limit_per_customer
  ) values(
    p_tenant_id,v_promotion,v_version,'PUBLISHED',coalesce((p_rule->>'priority')::int,50),
    coalesce((p_rule->>'stackable')::boolean,false),v_starts,v_ends,
    jsonb_build_object('condition',v_condition,'reward',v_reward,'engineVersion','2.0.0'),now(),v_total,v_per_customer
  ) returning id into v_version_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PROMOTION_PUBLISHED','promotion',v_promotion,
    jsonb_build_object('version',v_version,'type',v_type,'startsAt',v_starts,'endsAt',v_ends));
  return jsonb_build_object('id',v_version_id,'promotionId',v_promotion,'version',v_version,'status','PUBLISHED');
end $$;

create or replace function public.retire_promotion_version(
  p_tenant_id uuid, p_actor_id uuid, p_version_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype; v_version public.promotion_versions%rowtype;
begin
  select * into v_actor from public.profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role not in ('OWNER','ADMIN') then raise exception 'Akun tidak dapat menghentikan promo'; end if;
  update public.promotion_versions set status='RETIRED'
    where id=p_version_id and tenant_id=p_tenant_id and status='PUBLISHED' returning * into v_version;
  if not found then raise exception 'Promo aktif tidak ditemukan'; end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PROMOTION_RETIRED','promotion',v_version.promotion_id,jsonb_build_object('version',v_version.version));
  return jsonb_build_object('id',v_version.id,'status','RETIRED');
end $$;

create or replace function public.record_promotion_redemptions()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_promo jsonb; v_version_id uuid; v_version public.promotion_versions%rowtype;
  v_sale public.sales%rowtype; v_existing uuid; v_customer_total integer;
begin
  if jsonb_typeof(new.promotion_snapshot)<>'array' then return new; end if;
  select * into v_sale from public.sales where id=new.sale_id;
  for v_promo in select value from jsonb_array_elements(new.promotion_snapshot) loop
    begin v_version_id:=(v_promo->>'id')::uuid; exception when invalid_text_representation then continue; end;
    select id into v_existing from public.promotion_redemptions
      where promotion_version_id=v_version_id and sale_id=new.sale_id;
    if found then
      update public.promotion_redemptions set discount_amount=discount_amount+coalesce((v_promo->>'discount')::numeric,0)
        where id=v_existing;
      continue;
    end if;
    select * into v_version from public.promotion_versions
      where id=v_version_id and tenant_id=new.tenant_id for update;
    if not found then continue; end if;
    if v_version.usage_limit_total is not null then
      if v_version.usage_count>=v_version.usage_limit_total then raise exception 'Batas pemakaian promo % sudah habis',v_promo->>'code'; end if;
    end if;
    if v_version.usage_limit_per_customer is not null then
      if v_sale.customer_id is null then raise exception 'Promo % memerlukan pelanggan terdaftar',v_promo->>'code'; end if;
      select count(*) into v_customer_total from public.promotion_redemptions
        where promotion_version_id=v_version_id and customer_id=v_sale.customer_id;
      if v_customer_total>=v_version.usage_limit_per_customer then raise exception 'Batas promo % untuk pelanggan ini sudah habis',v_promo->>'code'; end if;
    end if;
    insert into public.promotion_redemptions(
      tenant_id,promotion_id,promotion_version_id,sale_id,customer_id,discount_amount,redeemed_at
    ) values(
      new.tenant_id,v_version.promotion_id,v_version.id,new.sale_id,v_sale.customer_id,
      coalesce((v_promo->>'discount')::numeric,0),v_sale.occurred_at
    );
    update public.promotion_versions set usage_count=usage_count+1 where id=v_version.id;
  end loop;
  return new;
end $$;

drop trigger if exists sale_item_records_promotion_redemption on public.sale_items;
create trigger sale_item_records_promotion_redemption after insert on public.sale_items
  for each row execute function public.record_promotion_redemptions();

revoke all on function public.publish_promotion_v2(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.retire_promotion_version(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_promotion_v2(uuid,uuid,jsonb) to service_role;
grant execute on function public.retire_promotion_version(uuid,uuid,uuid) to service_role;
