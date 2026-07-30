-- Link historical Kaspin receipts to customers imported afterwards.
-- Exact unique email is preferred. A unique exact name is only used when the receipt has no email.
begin;

create or replace function public.reconcile_kaspin_customer_sales_v1(
  p_tenant_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_by_email integer:=0;
  v_by_name integer:=0;
  v_customers integer:=0;
  v_unmatched integer:=0;
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat menghubungkan transaksi pelanggan'; end if;

  with matches as(
    select s.id sale_id,(array_agg(c.id order by c.created_at,c.id))[1] customer_id
    from public.sales s
    join public.customers c
      on c.tenant_id=s.tenant_id and c.active=true
      and lower(trim(c.email))=lower(trim(s.source_payload->>'customerEmail'))
    where s.tenant_id=p_tenant_id and s.source_system='KASPIN' and s.customer_id is null
      and nullif(trim(s.source_payload->>'customerEmail'),'') is not null
    group by s.id
    having count(*)=1
  ),updated as(
    update public.sales s
    set customer_id=m.customer_id,customer_group_id=c.group_id
    from matches m join public.customers c on c.id=m.customer_id
    where s.id=m.sale_id
    returning s.id
  )
  select count(*) into v_by_email from updated;

  with matches as(
    select s.id sale_id,(array_agg(c.id order by c.created_at,c.id))[1] customer_id
    from public.sales s
    join public.customers c
      on c.tenant_id=s.tenant_id and c.active=true
      and lower(trim(c.name))=lower(trim(s.source_payload->>'customerName'))
    where s.tenant_id=p_tenant_id and s.source_system='KASPIN' and s.customer_id is null
      and nullif(trim(s.source_payload->>'customerEmail'),'') is null
      and nullif(trim(s.source_payload->>'customerName'),'') is not null
    group by s.id
    having count(*)=1
  ),updated as(
    update public.sales s
    set customer_id=m.customer_id,customer_group_id=c.group_id
    from matches m join public.customers c on c.id=m.customer_id
    where s.id=m.sale_id
    returning s.id
  )
  select count(*) into v_by_name from updated;

  with totals as(
    select customer_id,sum(grand_total) lifetime_spend,max(occurred_at) last_purchase_at
    from public.sales
    where tenant_id=p_tenant_id and customer_id is not null and status='COMPLETED'
    group by customer_id
  ),updated as(
    update public.customers c
    set lifetime_spend=t.lifetime_spend,last_purchase_at=t.last_purchase_at
    from totals t
    where c.tenant_id=p_tenant_id and c.id=t.customer_id
    returning c.id
  )
  select count(*) into v_customers from updated;

  update public.customers c
  set tier_id=(
    select t.id from public.customer_tiers t
    where t.tenant_id=p_tenant_id and t.active=true and t.min_lifetime_spend<=c.lifetime_spend
    order by t.min_lifetime_spend desc limit 1
  )
  where c.tenant_id=p_tenant_id
    and exists(select 1 from public.sales s where s.tenant_id=p_tenant_id and s.customer_id=c.id and s.status='COMPLETED');

  select count(*) into v_unmatched
  from public.sales
  where tenant_id=p_tenant_id and source_system='KASPIN' and customer_id is null
    and (
      nullif(trim(source_payload->>'customerEmail'),'') is not null
      or nullif(trim(source_payload->>'customerName'),'') is not null
    );

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'KASPIN_CUSTOMER_SALES_RECONCILED','customers',null,
    jsonb_build_object(
      'linkedByEmail',v_by_email,'linkedByName',v_by_name,
      'customersUpdated',v_customers,'unmatchedReceipts',v_unmatched
    )
  );

  return jsonb_build_object(
    'linkedByEmail',v_by_email,'linkedByName',v_by_name,
    'linkedReceipts',v_by_email+v_by_name,'customersUpdated',v_customers,
    'unmatchedReceipts',v_unmatched
  );
end
$$;

revoke all on function public.reconcile_kaspin_customer_sales_v1(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.reconcile_kaspin_customer_sales_v1(uuid,uuid)
  to service_role;

-- Repair tenants that imported sales before importing their customer directory.
do $$
declare
  v_context record;
begin
  for v_context in
    select distinct on(p.tenant_id) p.tenant_id,p.user_id
    from public.profiles p
    where p.active=true and p.role='OWNER'
      and exists(
        select 1 from public.sales s
        where s.tenant_id=p.tenant_id and s.source_system='KASPIN' and s.customer_id is null
      )
    order by p.tenant_id,p.created_at,p.user_id
  loop
    perform public.reconcile_kaspin_customer_sales_v1(v_context.tenant_id,v_context.user_id);
  end loop;
end
$$;

commit;
