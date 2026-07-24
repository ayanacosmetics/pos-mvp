-- Kasir Nusa POS v1.20 - fixed order promotion and duplicate customer phone guard

create or replace function public.prevent_duplicate_customer_phone()
returns trigger language plpgsql set search_path=public as $$
declare
  v_phone text;
begin
  v_phone := regexp_replace(coalesce(new.phone,''),'[^0-9]','','g');
  if new.active=true and v_phone<>'' and exists(
    select 1 from public.customers c
    where c.tenant_id=new.tenant_id
      and c.id is distinct from new.id
      and c.active=true
      and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone
  ) then
    raise exception 'Nomor telepon sudah terdaftar pada pelanggan lain';
  end if;
  return new;
end $$;

drop trigger if exists customer_phone_must_be_unique on public.customers;
create trigger customer_phone_must_be_unique
before insert or update of tenant_id,phone,active on public.customers
for each row execute function public.prevent_duplicate_customer_phone();

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
  v_starts:=(p_rule->>'startsAt')::timestamptz;
  v_ends:=(p_rule->>'endsAt')::timestamptz;
  v_total:=nullif(p_rule->>'usageLimitTotal','')::integer;
  v_per_customer:=nullif(p_rule->>'usageLimitPerCustomer','')::integer;

  if v_code='' or length(v_code)>30 then raise exception 'Kode promo wajib 1-30 huruf atau angka'; end if;
  if v_name='' then raise exception 'Nama promo wajib diisi'; end if;
  if v_ends<=v_starts then raise exception 'Waktu selesai promo harus setelah waktu mulai'; end if;
  if v_type not in ('PERCENT_ITEM','FIXED_ITEM','FIXED_ORDER','SPECIAL_PRICE','PERCENT_ORDER','BUY_X_GET_Y','BUNDLE_FIXED')
    then raise exception 'Jenis promo tidak valid'; end if;
  if v_type in ('PERCENT_ITEM','FIXED_ITEM','FIXED_ORDER','SPECIAL_PRICE','PERCENT_ORDER','BUNDLE_FIXED')
    and coalesce((v_reward->>'value')::numeric,0)<=0 then raise exception 'Nilai promo harus lebih dari nol'; end if;
  if v_type in ('PERCENT_ITEM','PERCENT_ORDER') and (v_reward->>'value')::numeric>100
    then raise exception 'Diskon persen maksimal 100'; end if;
  if v_type='FIXED_ORDER' and upper(coalesce(v_reward->>'repeatMode','ONCE')) not in ('ONCE','MULTIPLE')
    then raise exception 'Perulangan promo harus ONCE atau MULTIPLE'; end if;
  if v_type='FIXED_ORDER' and nullif(v_reward->>'repeatCap','') is not null
    and (v_reward->>'repeatCap')::integer<=0 then raise exception 'Maksimal kelipatan harus lebih dari nol'; end if;
  if v_type='BUY_X_GET_Y' and (
    coalesce((v_reward->>'buyQty')::numeric,0)<=0 or coalesce((v_reward->>'freeQty')::numeric,0)<=0
  ) then raise exception 'Jumlah beli dan gratis harus lebih dari nol'; end if;
  if v_type='BUNDLE_FIXED' and jsonb_array_length(coalesce(v_condition->'bundle','[]'::jsonb))<2
    then raise exception 'Paket bundling minimal berisi dua produk'; end if;
  if v_total is not null and v_total<=0 then raise exception 'Batas total pemakaian harus lebih dari nol'; end if;
  if v_per_customer is not null and v_per_customer<=0 then raise exception 'Batas per pelanggan harus lebih dari nol'; end if;

  select id into v_promotion from public.promotions
  where tenant_id=p_tenant_id and code=v_code for update;
  if v_promotion is null then
    insert into public.promotions(tenant_id,code,name)
    values(p_tenant_id,v_code,v_name) returning id into v_promotion;
  else
    update public.promotions set name=v_name where id=v_promotion;
  end if;

  select coalesce(max(version),0)+1 into v_version
  from public.promotion_versions where promotion_id=v_promotion;
  update public.promotion_versions set status='RETIRED'
  where promotion_id=v_promotion and status='PUBLISHED';
  insert into public.promotion_versions(
    tenant_id,promotion_id,version,status,priority,stackable,starts_at,ends_at,rule_json,published_at,
    usage_limit_total,usage_limit_per_customer
  ) values(
    p_tenant_id,v_promotion,v_version,'PUBLISHED',coalesce((p_rule->>'priority')::int,50),
    coalesce((p_rule->>'stackable')::boolean,false),v_starts,v_ends,
    jsonb_build_object('condition',v_condition,'reward',v_reward,'engineVersion','2.1.0'),
    now(),v_total,v_per_customer
  ) returning id into v_version_id;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'PROMOTION_PUBLISHED','promotion',v_promotion,
    jsonb_build_object('version',v_version,'type',v_type,'startsAt',v_starts,'endsAt',v_ends)
  );
  return jsonb_build_object(
    'id',v_version_id,'promotionId',v_promotion,'version',v_version,'status','PUBLISHED'
  );
end $$;

revoke all on function public.publish_promotion_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_promotion_v2(uuid,uuid,jsonb) to service_role;
