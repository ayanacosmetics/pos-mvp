begin;

create table if not exists public.safe_customer_price_policies(
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  min_profit numeric(19,4) not null default 500 check(min_profit>=0),
  category text,
  brand text,
  rules_json jsonb not null default '[]'::jsonb check(jsonb_typeof(rules_json)='array'),
  active boolean not null default true,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.price_rules
  add column if not exists source text not null default 'MANUAL',
  add column if not exists policy_tenant_id uuid references public.safe_customer_price_policies(tenant_id) on delete set null;

alter table public.safe_customer_price_policies enable row level security;
revoke all on table public.safe_customer_price_policies from anon,authenticated;
grant all on table public.safe_customer_price_policies to service_role;

create or replace function public.refresh_safe_customer_prices_v1(
  p_tenant_id uuid,p_product_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_policy public.safe_customer_price_policies%rowtype;
  v_product record; v_rule jsonb; v_retail numeric; v_cost numeric;
  v_price numeric; v_profit numeric; v_group text; v_min_qty integer;
  v_discount numeric; v_safe integer:=0; v_skipped integer:=0; v_products integer:=0;
begin
  select * into v_policy from public.safe_customer_price_policies
  where tenant_id=p_tenant_id and active=true;
  if not found then return jsonb_build_object('active',false,'products',0,'safeRules',0,'skippedRules',0); end if;

  for v_product in
    select id from public.products
    where tenant_id=p_tenant_id and active=true
      and (p_product_id is null or id=p_product_id)
      and (v_policy.category is null or category=v_policy.category)
      and (v_policy.brand is null or brand=v_policy.brand)
  loop
    select unit_price_base into v_retail from public.price_rules
    where tenant_id=p_tenant_id and product_id=v_product.id
      and customer_group_id='retail' and min_base_qty=1
      and starts_at is null and ends_at is null
    order by case when source='MANUAL' then 0 else 1 end,priority desc limit 1;
    if v_retail is null then continue; end if;
    select coalesce(max(avg_cost),0) into v_cost from public.stock_balances
    where tenant_id=p_tenant_id and product_id=v_product.id;

    delete from public.price_rules pr
    where pr.tenant_id=p_tenant_id and pr.product_id=v_product.id
      and pr.starts_at is null and pr.ends_at is null
      and ((pr.customer_group_id is null and pr.min_base_qty>1) or exists(
        select 1 from jsonb_array_elements(v_policy.rules_json) rule
        where pr.customer_group_id=rule->>'customerGroupId'
          and pr.min_base_qty=(rule->>'minBaseQty')::numeric
      ));

    for v_rule in select value from jsonb_array_elements(v_policy.rules_json) loop
      v_group:=trim(v_rule->>'customerGroupId');
      v_min_qty:=(v_rule->>'minBaseQty')::integer;
      v_discount:=(v_rule->>'discountAmount')::numeric;
      v_price:=v_retail-v_discount;
      v_profit:=v_price-v_cost;
      if v_cost>0 and v_price>0 and v_profit>=v_policy.min_profit then
        insert into public.price_rules(
          tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,
          priority,source,policy_tenant_id
        ) values(
          p_tenant_id,v_product.id,v_group,v_min_qty,v_price,
          40,'AUTOMATIC',p_tenant_id
        );
        v_safe:=v_safe+1;
      else
        v_skipped:=v_skipped+1;
      end if;
    end loop;
    v_products:=v_products+1;
  end loop;
  return jsonb_build_object('active',true,'products',v_products,'safeRules',v_safe,'skippedRules',v_skipped);
end $$;

create or replace function public.apply_safe_price_policy_v1(
  p_tenant_id uuid,p_actor_id uuid,p_policy jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_rule jsonb; v_key text; v_seen text[]:=array[]::text[];
  v_group text; v_min_qty integer; v_discount numeric; v_min_profit numeric;
  v_result jsonb;
begin
  if not exists(
    select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id
      and active=true and role in ('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat menerapkan harga massal'; end if;

  v_min_profit:=coalesce((p_policy->>'minProfit')::numeric,500);
  if v_min_profit<0 then raise exception 'Keuntungan minimum tidak valid'; end if;
  if jsonb_typeof(p_policy->'rules')<>'array' or jsonb_array_length(p_policy->'rules')=0
    then raise exception 'Aturan harga wajib diisi'; end if;

  for v_rule in select value from jsonb_array_elements(p_policy->'rules') loop
    v_group:=trim(v_rule->>'customerGroupId');
    v_min_qty:=(v_rule->>'minBaseQty')::integer;
    v_discount:=(v_rule->>'discountAmount')::numeric;
    v_key:=v_group||':'||v_min_qty::text;
    if v_group='retail' or v_min_qty<1 or v_discount<=0 then raise exception 'Aturan harga tidak valid'; end if;
    if v_key=any(v_seen) then raise exception 'Aturan harga % tercatat dua kali',v_key; end if;
    if not exists(
      select 1 from public.customer_price_groups
      where tenant_id=p_tenant_id and id=v_group and active=true
    ) then raise exception 'Tipe pelanggan % tidak aktif',v_group; end if;
    v_seen:=array_append(v_seen,v_key);
  end loop;

  insert into public.safe_customer_price_policies(
    tenant_id,min_profit,category,brand,rules_json,active,updated_by,updated_at
  ) values(
    p_tenant_id,v_min_profit,nullif(trim(p_policy->>'category'),''),
    nullif(trim(p_policy->>'brand'),''),p_policy->'rules',true,p_actor_id,now()
  ) on conflict(tenant_id) do update set
    min_profit=excluded.min_profit,category=excluded.category,brand=excluded.brand,
    rules_json=excluded.rules_json,active=true,updated_by=p_actor_id,updated_at=now();

  v_result:=public.refresh_safe_customer_prices_v1(p_tenant_id,null);
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SAFE_PRICE_POLICY_APPLIED','tenant',p_tenant_id,p_policy||v_result);
  return v_result;
end $$;

create or replace function public.save_product_v6(
  p_tenant_id uuid,p_actor_id uuid,p_product jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb; v_product_id uuid;
begin
  v_result:=public.save_product_v5(p_tenant_id,p_actor_id,p_product);
  v_product_id:=(v_result->>'id')::uuid;
  perform public.refresh_safe_customer_prices_v1(p_tenant_id,v_product_id);
  return v_result;
end $$;

create or replace function public.stock_balance_refresh_safe_prices()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' then
    perform public.refresh_safe_customer_prices_v1(new.tenant_id,new.product_id);
  elsif new.avg_cost is distinct from old.avg_cost then
    perform public.refresh_safe_customer_prices_v1(new.tenant_id,new.product_id);
  end if;
  return new;
end $$;

drop trigger if exists stock_balances_refresh_safe_prices on public.stock_balances;
create trigger stock_balances_refresh_safe_prices
after insert or update of avg_cost on public.stock_balances
for each row execute function public.stock_balance_refresh_safe_prices();

revoke all on function public.refresh_safe_customer_prices_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.apply_safe_price_policy_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_product_v6(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.refresh_safe_customer_prices_v1(uuid,uuid) to service_role;
grant execute on function public.apply_safe_price_policy_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.save_product_v6(uuid,uuid,jsonb) to service_role;

commit;
