-- Owner dan Admin dapat mengelola akses staff.
-- Admin tidak dapat mengubah Owner, sesama Admin, atau dirinya sendiri.

create or replace function public.manage_profile_access(
  p_tenant_id uuid, p_actor_id uuid, p_user_id uuid, p_display_name text,
  p_role text, p_active boolean, p_outlet_ids uuid[]
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_outlet uuid;
  v_owner_count int;
  v_was_existing boolean;
begin
  select * into v_actor
  from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;

  if not found or v_actor.role not in ('OWNER','ADMIN') then
    raise exception 'Hanya Owner atau Admin yang dapat mengelola staff';
  end if;
  if p_role not in ('OWNER','ADMIN','MANAGER','CASHIER','PURCHASING','WAREHOUSE') then
    raise exception 'Peran user tidak valid';
  end if;
  if nullif(trim(p_display_name),'') is null then
    raise exception 'Nama user wajib diisi';
  end if;

  select * into v_target
  from public.profiles
  where user_id=p_user_id
  for update;
  v_was_existing:=found;

  if v_was_existing and v_target.tenant_id<>p_tenant_id then
    raise exception 'User sudah terhubung dengan usaha lain';
  end if;
  if v_actor.role='ADMIN' and (
    p_user_id=p_actor_id or p_role in ('OWNER','ADMIN') or
    (v_was_existing and v_target.role in ('OWNER','ADMIN'))
  ) then
    raise exception 'Admin hanya dapat mengelola staff operasional';
  end if;
  if p_user_id=p_actor_id and not p_active then
    raise exception 'Pengguna tidak dapat menonaktifkan akun sendiri';
  end if;
  if p_role<>'OWNER' and coalesce(array_length(p_outlet_ids,1),0)=0 then
    raise exception 'User harus ditempatkan minimal pada satu outlet';
  end if;

  foreach v_outlet in array coalesce(p_outlet_ids,array[]::uuid[]) loop
    if not exists(
      select 1 from public.outlets
      where id=v_outlet and tenant_id=p_tenant_id and active=true
    ) then
      raise exception 'Outlet user tidak valid';
    end if;
  end loop;

  if v_was_existing and v_target.role='OWNER' and (p_role<>'OWNER' or not p_active) then
    select count(*) into v_owner_count
    from public.profiles
    where tenant_id=p_tenant_id and role='OWNER' and active=true;
    if v_owner_count<=1 then
      raise exception 'Usaha harus memiliki minimal satu Owner aktif';
    end if;
  end if;

  insert into public.profiles(user_id,tenant_id,display_name,role,active)
  values(p_user_id,p_tenant_id,trim(p_display_name),p_role,p_active)
  on conflict(user_id) do update set
    display_name=excluded.display_name,
    role=excluded.role,
    active=excluded.active;

  delete from public.user_outlets
  where tenant_id=p_tenant_id and user_id=p_user_id;

  if p_role='OWNER' then
    insert into public.user_outlets(tenant_id,user_id,outlet_id)
    select p_tenant_id,p_user_id,id
    from public.outlets
    where tenant_id=p_tenant_id and active=true
    on conflict do nothing;
  else
    foreach v_outlet in array p_outlet_ids loop
      insert into public.user_outlets(tenant_id,user_id,outlet_id)
      values(p_tenant_id,p_user_id,v_outlet);
    end loop;
  end if;

  insert into public.audit_logs(
    tenant_id,actor_id,action,entity_type,entity_id,details_json
  ) values (
    p_tenant_id,p_actor_id,
    case when v_was_existing then 'USER_ACCESS_UPDATED' else 'USER_CREATED' end,
    'profile',p_user_id,
    jsonb_build_object(
      'displayName',trim(p_display_name),'role',p_role,'active',p_active,
      'outletIds',coalesce(p_outlet_ids,array[]::uuid[])
    )
  );

  return jsonb_build_object(
    'userId',p_user_id,'displayName',trim(p_display_name),
    'role',p_role,'active',p_active,
    'outletIds',(
      select coalesce(jsonb_agg(outlet_id),'[]')
      from public.user_outlets where user_id=p_user_id
    )
  );
end $$;

revoke all on function public.manage_profile_access(
  uuid,uuid,uuid,text,text,boolean,uuid[]
) from public,anon,authenticated;
grant execute on function public.manage_profile_access(
  uuid,uuid,uuid,text,text,boolean,uuid[]
) to service_role;
