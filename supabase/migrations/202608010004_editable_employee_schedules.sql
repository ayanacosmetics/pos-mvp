-- Jadwal berulang diedit berdasarkan ID dan tidak lagi menutup jadwal lain.

create or replace function public.save_employee_shift_rule_v2(
  p_tenant_id uuid,p_actor_id uuid,p_rule_id uuid,p_user_id uuid,p_outlet_id uuid,
  p_effective_from date,p_weekdays smallint[],p_starts_at time,p_ends_at time,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_rule public.employee_shift_rules%rowtype;v_existing public.employee_shift_rules%rowtype;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id
    and active and role in('OWNER','ADMIN','MANAGER')) then
    raise exception 'Anda tidak dapat mengatur jadwal karyawan';
  end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_user_id and active) then
    raise exception 'Karyawan aktif tidak ditemukan';
  end if;
  if not exists(select 1 from public.outlets where tenant_id=p_tenant_id and id=p_outlet_id and active) then
    raise exception 'Outlet tidak valid';
  end if;
  if p_effective_from is null or p_starts_at is null or p_ends_at is null or p_ends_at<=p_starts_at then
    raise exception 'Tanggal dan jam shift tidak valid';
  end if;
  if coalesce(cardinality(p_weekdays),0)<1 or not p_weekdays <@ array[1,2,3,4,5,6,7]::smallint[] then
    raise exception 'Pilih minimal satu hari kerja';
  end if;
  if p_rule_id is not null then
    select * into v_existing from public.employee_shift_rules
    where id=p_rule_id and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Jadwal berulang tidak ditemukan'; end if;
  end if;
  if exists(
    select 1 from public.employee_shift_rules rule
    where rule.tenant_id=p_tenant_id and rule.user_id=p_user_id and rule.outlet_id=p_outlet_id
      and rule.active=true and (p_rule_id is null or rule.id<>p_rule_id)
      and rule.weekdays && p_weekdays
  ) then
    raise exception 'Hari kerja bertabrakan dengan jadwal aktif. Edit jadwal tersebut atau pilih hari lain';
  end if;
  if p_rule_id is null then
    insert into public.employee_shift_rules(
      tenant_id,user_id,outlet_id,effective_from,weekdays,starts_at,ends_at,note,created_by
    ) values(
      p_tenant_id,p_user_id,p_outlet_id,p_effective_from,
      array(select distinct day from unnest(p_weekdays) day order by day),
      p_starts_at,p_ends_at,nullif(trim(coalesce(p_note,'')),''),p_actor_id
    ) returning * into v_rule;
  else
    update public.employee_shift_rules set
      user_id=p_user_id,outlet_id=p_outlet_id,effective_from=p_effective_from,effective_until=null,
      weekdays=array(select distinct day from unnest(p_weekdays) day order by day),
      starts_at=p_starts_at,ends_at=p_ends_at,note=nullif(trim(coalesce(p_note,'')),''),
      active=true,updated_at=now()
    where id=p_rule_id returning * into v_rule;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,
    case when p_rule_id is null then 'EMPLOYEE_SHIFT_RULE_CREATED' else 'EMPLOYEE_SHIFT_RULE_EDITED' end,
    'employee_shift_rule',v_rule.id,jsonb_build_object('userId',p_user_id,'outletId',p_outlet_id,
      'effectiveFrom',p_effective_from,'weekdays',p_weekdays,'startsAt',p_starts_at,'endsAt',p_ends_at));
  return to_jsonb(v_rule);
end $$;

revoke all on function public.save_employee_shift_rule_v2(uuid,uuid,uuid,uuid,uuid,date,smallint[],time,time,text)
  from public,anon,authenticated;
grant execute on function public.save_employee_shift_rule_v2(uuid,uuid,uuid,uuid,uuid,date,smallint[],time,time,text)
  to service_role;
