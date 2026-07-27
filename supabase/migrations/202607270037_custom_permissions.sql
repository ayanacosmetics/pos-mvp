-- Kasir Nusa POS v2.4.9 - hak akses per akun tanpa berbagi sandi Owner

alter table public.profiles
  add column if not exists custom_permissions text[];

alter table public.profiles
  drop constraint if exists profiles_custom_permissions_allowed;

alter table public.profiles
  add constraint profiles_custom_permissions_allowed check (
    custom_permissions is null or custom_permissions <@ array[
      'pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage',
      'sales.return','catalog.manage','promotion.manage','report.view','audit.view',
      'workforce.self','workforce.manage','approval.manage','multioutlet.view',
      'multioutlet.manage','sale.adjust','sale.void'
    ]::text[]
  );

create or replace function public.manage_profile_access_v2(
  p_tenant_id uuid, p_actor_id uuid, p_user_id uuid, p_display_name text,
  p_role text, p_active boolean, p_outlet_ids uuid[], p_permissions text[]
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;
  v_permissions text[];
begin
  if p_role='OWNER' then
    v_permissions:=null;
  else
    v_permissions:=array(
      select distinct permission
      from unnest(coalesce(p_permissions,array[]::text[])) permission
      order by permission
    );
    if not v_permissions <@ array[
      'pos.sell','purchasing.view_cost','purchasing.receive','inventory.manage',
      'sales.return','catalog.manage','promotion.manage','report.view','audit.view',
      'workforce.self','workforce.manage','approval.manage','multioutlet.view',
      'multioutlet.manage','sale.adjust','sale.void'
    ]::text[] then
      raise exception 'Hak akses pengguna tidak valid';
    end if;
  end if;

  v_result:=public.manage_profile_access(
    p_tenant_id,p_actor_id,p_user_id,p_display_name,p_role,p_active,p_outlet_ids
  );

  update public.profiles
  set custom_permissions=v_permissions
  where tenant_id=p_tenant_id and user_id=p_user_id;

  insert into public.audit_logs(
    tenant_id,actor_id,action,entity_type,entity_id,details_json
  ) values (
    p_tenant_id,p_actor_id,'USER_PERMISSIONS_UPDATED','profile',p_user_id,
    jsonb_build_object('role',p_role,'permissions',coalesce(to_jsonb(v_permissions),'null'::jsonb))
  );

  return v_result || jsonb_build_object(
    'permissions',coalesce(to_jsonb(v_permissions),'null'::jsonb)
  );
end $$;

revoke all on function public.manage_profile_access_v2(
  uuid,uuid,uuid,text,text,boolean,uuid[],text[]
) from public,anon,authenticated;
grant execute on function public.manage_profile_access_v2(
  uuid,uuid,uuid,text,text,boolean,uuid[],text[]
) to service_role;
