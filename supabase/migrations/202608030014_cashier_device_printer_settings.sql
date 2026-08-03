-- Pengaturan printer bersifat per perangkat. Kasir boleh mengatur perangkat
-- pada outlet tempat ia ditugaskan, tanpa mendapat akses pengaturan usaha.
create or replace function public.save_pos_device_settings(
  p_tenant_id uuid, p_actor_id uuid, p_device_id uuid, p_outlet_id uuid,
  p_name text, p_platform text, p_paper_width integer, p_auto_print boolean, p_receipt_copies integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype;
  v_device public.pos_devices%rowtype;
begin
  select * into v_actor
  from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;

  if not found or v_actor.role not in ('OWNER','CASHIER') then
    raise exception 'Hanya Owner atau kasir aktif yang dapat mengubah perangkat kasir';
  end if;
  if v_actor.role='CASHIER' and not exists(
    select 1 from public.user_outlets
    where tenant_id=p_tenant_id and user_id=p_actor_id and outlet_id=p_outlet_id
  ) then
    raise exception 'Kasir hanya dapat mengatur perangkat pada outlet penugasannya';
  end if;
  if not exists(
    select 1 from public.outlets
    where id=p_outlet_id and tenant_id=p_tenant_id and active=true
  ) then
    raise exception 'Outlet perangkat tidak valid';
  end if;
  if p_paper_width not in (58,80) then
    raise exception 'Ukuran kertas harus 58 mm atau 80 mm';
  end if;
  if p_receipt_copies<1 or p_receipt_copies>3 then
    raise exception 'Jumlah salinan struk harus 1 sampai 3';
  end if;

  insert into public.pos_devices(
    id,tenant_id,outlet_id,name,platform,active,created_by,
    paper_width,auto_print,receipt_copies,last_seen_at,updated_at
  ) values(
    p_device_id,p_tenant_id,p_outlet_id,coalesce(nullif(trim(p_name),''),'Perangkat POS'),
    nullif(trim(p_platform),''),true,p_actor_id,p_paper_width,
    coalesce(p_auto_print,false),p_receipt_copies,now(),now()
  )
  on conflict(id) do update set
    outlet_id=excluded.outlet_id,name=excluded.name,platform=excluded.platform,
    paper_width=excluded.paper_width,auto_print=excluded.auto_print,
    receipt_copies=excluded.receipt_copies,active=true,last_seen_at=now(),updated_at=now()
  where public.pos_devices.tenant_id=excluded.tenant_id
  returning * into v_device;

  if v_device.id is null then
    raise exception 'Perangkat terdaftar pada usaha yang berbeda';
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'POS_DEVICE_CONFIGURED','pos_device',p_device_id,
    jsonb_build_object(
      'name',v_device.name,'outletId',v_device.outlet_id,
      'paperWidth',v_device.paper_width,'actorRole',v_actor.role
    )
  );
  return to_jsonb(v_device);
end $$;

revoke all on function public.save_pos_device_settings(uuid,uuid,uuid,uuid,text,text,integer,boolean,integer)
  from public,anon,authenticated;
grant execute on function public.save_pos_device_settings(uuid,uuid,uuid,uuid,text,text,integer,boolean,integer)
  to service_role;
