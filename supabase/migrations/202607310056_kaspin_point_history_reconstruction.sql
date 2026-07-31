-- Reconstruct per-receipt Kasir Pintar points while preserving the imported final balance.
-- Source data earns 1 point per Rp10.000, rounded down for every receipt.
begin;

create or replace function public.reconstruct_kaspin_points_v1(
  p_tenant_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_customer record;
  v_sale record;
  v_import_entry record;
  v_has_import_entry boolean;
  v_target_balance integer;
  v_running_balance integer;
  v_earned integer;
  v_difference integer;
  v_adjusted_at timestamptz;
  v_customers integer:=0;
  v_receipts integer:=0;
  v_adjustments integer:=0;
  v_skipped integer:=0;
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat merekonstruksi poin impor'; end if;

  for v_customer in
    select c.id,c.loyalty_points
    from public.customers c
    where c.tenant_id=p_tenant_id
      and exists(
        select 1 from public.sales s
        where s.tenant_id=p_tenant_id and s.customer_id=c.id
          and s.source_system='KASPIN' and s.status='COMPLETED'
      )
      and not exists(
        select 1
        from public.customer_point_entries pe
        join public.sales ps on ps.id=pe.sale_id
        where pe.tenant_id=p_tenant_id and pe.customer_id=c.id
          and ps.source_system='KASPIN'
      )
  loop
    select pe.* into v_import_entry
    from public.customer_point_entries pe
    where pe.tenant_id=p_tenant_id and pe.customer_id=v_customer.id
      and pe.entry_type='ADJUST' and pe.sale_id is null
      and pe.note='Saldo poin awal dari Kasir Pintar'
    order by pe.occurred_at desc,pe.id desc
    limit 1;
    v_has_import_entry:=found;

    if v_has_import_entry then
      v_target_balance:=v_import_entry.balance_after;
      v_adjusted_at:=v_import_entry.occurred_at;
      delete from public.customer_point_entries where id=v_import_entry.id;
    elsif not exists(
      select 1 from public.customer_point_entries pe
      where pe.tenant_id=p_tenant_id and pe.customer_id=v_customer.id
    ) then
      v_target_balance:=v_customer.loyalty_points;
      v_adjusted_at:=now();
    else
      -- Do not reorder an unrelated existing point history.
      v_skipped:=v_skipped+1;
      continue;
    end if;

    v_running_balance:=0;
    for v_sale in
      select s.id,s.grand_total,s.occurred_at
      from public.sales s
      where s.tenant_id=p_tenant_id and s.customer_id=v_customer.id
        and s.source_system='KASPIN' and s.status='COMPLETED'
      order by s.occurred_at,s.id
    loop
      v_earned:=floor(greatest(v_sale.grand_total,0)/10000)::integer;
      v_running_balance:=v_running_balance+v_earned;

      update public.sales
      set points_earned=v_earned,
          source_payload=coalesce(source_payload,'{}'::jsonb)||jsonb_build_object(
            'pointsEarned',v_earned,
            'pointsBalanceAfter',v_running_balance,
            'pointsReconstructed',true
          )
      where id=v_sale.id;

      if v_earned>0 then
        insert into public.customer_point_entries(
          tenant_id,customer_id,sale_id,entry_type,points,balance_after,note,
          actor_id,idempotency_key,occurred_at
        ) values(
          p_tenant_id,v_customer.id,v_sale.id,'EARN',v_earned,v_running_balance,
          'Poin transaksi impor Kasir Pintar',p_actor_id,
          'KASPIN:EARN:'||v_sale.id::text,v_sale.occurred_at
        ) on conflict(tenant_id,idempotency_key) do nothing;
      end if;
      v_receipts:=v_receipts+1;
    end loop;

    v_difference:=v_target_balance-v_running_balance;
    if v_difference<>0 then
      insert into public.customer_point_entries(
        tenant_id,customer_id,sale_id,entry_type,points,balance_after,note,
        actor_id,idempotency_key,occurred_at
      ) values(
        p_tenant_id,v_customer.id,null,'ADJUST',v_difference,v_target_balance,
        'Penyesuaian selisih saldo impor Kasir Pintar',p_actor_id,
        'KASPIN:POINT-DIFFERENCE:'||v_customer.id::text,
        greatest(v_adjusted_at,coalesce((
          select max(s.occurred_at)+interval '1 second'
          from public.sales s
          where s.tenant_id=p_tenant_id and s.customer_id=v_customer.id
            and s.source_system='KASPIN'
        ),v_adjusted_at))
      ) on conflict(tenant_id,idempotency_key) do nothing;
      v_adjustments:=v_adjustments+1;
    end if;
    v_customers:=v_customers+1;
  end loop;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'KASPIN_POINTS_RECONSTRUCTED','customers',null,
    jsonb_build_object(
      'customers',v_customers,'receipts',v_receipts,
      'adjustments',v_adjustments,'skipped',v_skipped
    )
  );

  return jsonb_build_object(
    'customers',v_customers,'receipts',v_receipts,
    'adjustments',v_adjustments,'skipped',v_skipped
  );
end
$$;

revoke all on function public.reconstruct_kaspin_points_v1(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.reconstruct_kaspin_points_v1(uuid,uuid)
  to service_role;

-- Repair existing imports once when this migration is applied.
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
        where s.tenant_id=p.tenant_id and s.source_system='KASPIN'
          and s.customer_id is not null
      )
    order by p.tenant_id,p.created_at,p.user_id
  loop
    perform public.reconstruct_kaspin_points_v1(v_context.tenant_id,v_context.user_id);
  end loop;
end
$$;

commit;
