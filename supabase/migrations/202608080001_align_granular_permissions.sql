-- Make database mutation authorization match the granular permissions enforced
-- by the API. Owner-only/destructive workflows remain intentionally unchanged.

begin;

create or replace function public.profile_has_permission_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_permission text
) returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.profiles
    where tenant_id=p_tenant_id
      and user_id=p_actor_id
      and active=true
      and (
        role='OWNER'
        or case
          when custom_permissions is not null then
            p_permission=any(custom_permissions)
            or (p_permission='report.transactions' and 'report.view'=any(custom_permissions))
            or (role='ADMIN' and p_permission='identity.manage_staff')
            or (role='CASHIER' and p_permission='device.configure')
          when role='ADMIN' then p_permission=any(array[
            'pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage',
            'sales.return','catalog.manage','promotion.manage','report.transactions',
            'report.view','audit.view','identity.manage_staff','workforce.self',
            'workforce.manage','approval.manage','multioutlet.view','multioutlet.manage',
            'sale.adjust','sale.void'
          ]::text[])
          when role='MANAGER' then p_permission=any(array[
            'pos.sell','inventory.manage','sales.return','catalog.manage',
            'promotion.manage','report.transactions','report.view','audit.view',
            'workforce.self','workforce.manage','approval.manage','multioutlet.view',
            'multioutlet.manage'
          ]::text[])
          when role='CASHIER' then p_permission=any(array[
            'pos.sell','workforce.self','device.configure'
          ]::text[])
          when role='PURCHASING' then p_permission=any(array[
            'purchasing.view_cost','purchasing.receive','workforce.self'
          ]::text[])
          when role='WAREHOUSE' then p_permission=any(array[
            'inventory.manage','workforce.self'
          ]::text[])
          else false
        end
      )
  );
$$;

create or replace function public.profile_can_receive_purchase_v1(
  p_tenant_id uuid,p_actor_id uuid
) returns boolean language sql stable security definer set search_path=public as $$
  select public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive')
$$;

create or replace function public.can_manage_product_catalog_v1(
  p_tenant_id uuid,p_actor_id uuid
) returns boolean language sql stable security definer set search_path=public as $$
  select public.profile_has_permission_v1(p_tenant_id,p_actor_id,'catalog.manage')
$$;

-- Preserve the current business bodies and replace only their obsolete role
-- gates. The migration fails closed when an expected gate is no longer found.
do $audit$
declare
  v_target record;
  v_function record;
  v_body text;
  v_count integer;
begin
  for v_target in
    select * from (values
      ('create_sale_adjustment_authorization',
       $old$and role in ('OWNER','ADMIN');$old$,
       $new$and public.profile_has_permission_v1(p_tenant_id,p_approved_by,'sale.adjust');$new$),
      ('create_sale_adjustment_authorization',
       $old$and role in ('OWNER','ADMIN','CASHIER')$old$,
       $new$and public.profile_has_permission_v1(p_tenant_id,p_cashier_id,'pos.sell')$new$),
      ('process_customer_return_v2',
       $old$and role in ('OWNER','ADMIN'))$old$,
       $new$and public.profile_has_permission_v1(p_tenant_id,p_actor_id,'sales.return'))$new$),
      ('publish_promotion_v2',
       $old$if not found or v_actor.role not in ('OWNER','ADMIN') then raise exception 'Akun tidak dapat menerbitkan promo'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'promotion.manage') then raise exception 'Akun tidak memiliki izin mengelola promo'; end if;$new$),
      ('retire_promotion_version',
       $old$if not found or v_actor.role not in ('OWNER','ADMIN') then raise exception 'Akun tidak dapat menghentikan promo'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'promotion.manage') then raise exception 'Akun tidak memiliki izin mengelola promo'; end if;$new$),
      ('report_operational_summary',
       $old$if not found or v_actor.role not in ('OWNER','ADMIN') then
    raise exception 'Akun tidak memiliki hak melihat laporan';
  end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'report.view') then
    raise exception 'Akun tidak memiliki hak melihat laporan';
  end if;$new$),
      ('decide_approval_request',
       $old$if v_role not in ('OWNER','ADMIN') then raise exception 'Hanya Owner/Admin yang dapat menyetujui'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'approval.manage') then raise exception 'Akun tidak memiliki izin mengelola persetujuan'; end if;$new$),
      ('save_employee_shift_rule_v2',
       $old$if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN','MANAGER')) then raise exception 'Anda tidak dapat mengatur jadwal karyawan';end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'workforce.manage') then raise exception 'Anda tidak dapat mengatur jadwal karyawan';end if;$new$),
      ('request_stock_transfer_v1',
       $old$if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER','WAREHOUSE') then
    raise exception 'Akun tidak dapat membuat permintaan transfer';
  end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then
    raise exception 'Akun tidak dapat membuat permintaan transfer';
  end if;$new$),
      ('advance_stock_transfer_v1',
       $old$if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER','WAREHOUSE') then
    raise exception 'Akun tidak dapat memproses transfer';
  end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then
    raise exception 'Akun tidak dapat memproses transfer';
  end if;$new$),
      ('advance_stock_transfer_v1',
       $old$if v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Transfer harus disetujui Owner, Admin, atau Manajer Outlet'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then raise exception 'Akun tidak memiliki izin menyetujui transfer'; end if;$new$),
      ('advance_stock_transfer_v1',
       $old$if v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Transfer harus ditolak Owner, Admin, atau Manajer Outlet'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then raise exception 'Akun tidak memiliki izin menolak transfer'; end if;$new$),
      ('advance_stock_transfer_v1',
       $old$if v_role not in ('OWNER','ADMIN','MANAGER') and v_transfer.requested_by<>p_actor_id$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') and v_transfer.requested_by<>p_actor_id$new$),
      ('save_outlet_price_override_v1',
       $old$if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Akun tidak dapat mengubah harga outlet'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then raise exception 'Akun tidak dapat mengubah harga outlet'; end if;$new$),
      ('assign_promotion_outlets_v1',
       $old$if v_role is null or v_role not in ('OWNER','ADMIN','MANAGER') then raise exception 'Akun tidak dapat mengatur promo outlet'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'multioutlet.manage') then raise exception 'Akun tidak dapat mengatur promo outlet'; end if;$new$),
      ('save_restock_policy_v1',
       $old$if v_role is null or v_role not in ('OWNER','ADMIN','PURCHASING') then raise exception 'Akun tidak memiliki hak mengatur rencana restok'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then raise exception 'Akun tidak memiliki hak mengatur rencana restok'; end if;$new$),
      ('save_purchase_order',
       $old$if not exists(select 1 from profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active and role in('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak memiliki hak membuat Purchase Order';end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then raise exception 'Akun tidak memiliki hak membuat Purchase Order';end if;$new$),
      ('transition_purchase_order',
       $old$if v_role not in ('OWNER','ADMIN','PURCHASING') or v_order.status<>'DRAFT' then raise exception 'Purchase Order tidak dapat diajukan'; end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') or v_order.status<>'DRAFT' then raise exception 'Purchase Order tidak dapat diajukan'; end if;$new$),
      ('transition_purchase_order',
       $old$v_required:=v_order.grand_total>v_threshold and v_role='PURCHASING';$old$,
       $new$v_required:=v_order.grand_total>v_threshold and v_role not in ('OWNER','ADMIN');$new$),
      ('transition_purchase_order',
       $old$if v_role not in ('OWNER','ADMIN') and not (v_role='PURCHASING' and v_order.status='DRAFT') then raise exception 'Purchase Order tidak dapat dibatalkan'; end if;$old$,
       $new$if v_role not in ('OWNER','ADMIN') and not (public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') and v_order.status='DRAFT') then raise exception 'Purchase Order tidak dapat dibatalkan'; end if;$new$),
      ('record_supplier_payment',
       $old$if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak dapat membayar supplier';end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive') then raise exception 'Akun tidak dapat membayar supplier';end if;$new$),
      ('post_supplier_return',
       $old$and role in ('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak memiliki hak membuat retur supplier'; end if;$old$,
       $new$and public.profile_has_permission_v1(p_tenant_id,p_actor_id,'purchasing.receive')) then raise exception 'Akun tidak memiliki hak membuat retur supplier'; end if;$new$),
      ('record_customer_payment',
       $old$and role in ('OWNER','ADMIN','CASHIER')$old$,
       $new$and public.profile_has_permission_v1(p_tenant_id,p_actor_id,'pos.sell')$new$),
      ('void_sale_v1',
       $old$if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN','CASHIER')) then raise exception 'Akun tidak dapat membatalkan transaksi';end if;$old$,
       $new$if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'pos.sell') then raise exception 'Akun tidak dapat membatalkan transaksi';end if;$new$),
      ('void_sale_v1',
       $old$select * into v_approver from public.profiles where tenant_id=p_tenant_id and user_id=p_approved_by and active=true and role in('OWNER','ADMIN');$old$,
       $new$select * into v_approver from public.profiles where tenant_id=p_tenant_id and user_id=p_approved_by and active=true and public.profile_has_permission_v1(p_tenant_id,p_approved_by,'sale.void');$new$)
    ) as targets(function_name,old_fragment,new_fragment)
  loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_target.function_name;
    if v_count<>1 then
      raise exception 'Permission audit expected one public.% function, found %',v_target.function_name,v_count;
    end if;

    select p.oid,p.prosrc,pg_get_function_arguments(p.oid) arguments,
      pg_get_function_result(p.oid) result
    into v_function
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_target.function_name;

    v_body:=replace(v_function.prosrc,v_target.old_fragment,v_target.new_fragment);
    if v_body=v_function.prosrc then
      raise exception 'Obsolete permission gate not found in public.%',v_target.function_name;
    end if;

    execute format(
      'create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path=public as %L',
      v_target.function_name,v_function.arguments,v_function.result,v_body
    );
  end loop;
end
$audit$;

revoke all on function public.profile_has_permission_v1(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.profile_can_receive_purchase_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.can_manage_product_catalog_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.profile_has_permission_v1(uuid,uuid,text) to service_role;
grant execute on function public.profile_can_receive_purchase_v1(uuid,uuid) to service_role;
grant execute on function public.can_manage_product_catalog_v1(uuid,uuid) to service_role;

commit;
