-- Absensi berfoto, geofence usaha, dan jadwal shift yang berlaku sampai diubah.

alter table public.tenants add column if not exists attendance_latitude numeric(9,6);
alter table public.tenants add column if not exists attendance_longitude numeric(9,6);
alter table public.tenants add column if not exists attendance_radius_m integer not null default 100;
alter table public.tenants drop constraint if exists tenants_attendance_coordinates_valid;
alter table public.tenants add constraint tenants_attendance_coordinates_valid check (
  (attendance_latitude is null and attendance_longitude is null) or
  (attendance_latitude between -90 and 90 and attendance_longitude between -180 and 180)
);
alter table public.tenants drop constraint if exists tenants_attendance_radius_valid;
alter table public.tenants add constraint tenants_attendance_radius_valid
  check(attendance_radius_m between 20 and 1000);

alter table public.attendance_records add column if not exists clock_in_latitude numeric(9,6);
alter table public.attendance_records add column if not exists clock_in_longitude numeric(9,6);
alter table public.attendance_records add column if not exists clock_in_accuracy_m numeric(9,2);
alter table public.attendance_records add column if not exists clock_in_distance_m numeric(9,2);
alter table public.attendance_records add column if not exists clock_in_photo_path text;
alter table public.attendance_records add column if not exists clock_out_latitude numeric(9,6);
alter table public.attendance_records add column if not exists clock_out_longitude numeric(9,6);
alter table public.attendance_records add column if not exists clock_out_accuracy_m numeric(9,2);
alter table public.attendance_records add column if not exists clock_out_distance_m numeric(9,2);
alter table public.attendance_records add column if not exists clock_out_photo_path text;

create table if not exists public.employee_shift_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  effective_from date not null,
  effective_until date,
  weekdays smallint[] not null,
  starts_at time not null,
  ends_at time not null,
  note text,
  active boolean not null default true,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(ends_at>starts_at),
  check(effective_until is null or effective_until>=effective_from),
  check(cardinality(weekdays) between 1 and 7),
  check(weekdays <@ array[1,2,3,4,5,6,7]::smallint[])
);
create index if not exists employee_shift_rules_active_idx
  on public.employee_shift_rules(tenant_id,user_id,outlet_id,effective_from desc)
  where active=true;
alter table public.employee_shift_rules enable row level security;
drop policy if exists employee_shift_rules_tenant_read on public.employee_shift_rules;
create policy employee_shift_rules_tenant_read on public.employee_shift_rules
  for select to authenticated using(tenant_id=public.current_tenant_id());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('attendance-media','attendance-media',false,524288,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.save_business_settings_v2(
  p_tenant_id uuid,p_actor_id uuid,p_name text,p_legal_name text,p_phone text,
  p_email text,p_address text,p_tax_id text,p_receipt_footer text,p_logo_url text,
  p_attendance_latitude numeric,p_attendance_longitude numeric,p_attendance_radius_m integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_actor public.profiles%rowtype;v_result public.tenants%rowtype;
begin
  select * into v_actor from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role<>'OWNER' then
    raise exception 'Hanya Owner yang dapat mengubah identitas usaha';
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama usaha wajib diisi'; end if;
  if (p_attendance_latitude is null)<>(p_attendance_longitude is null) then
    raise exception 'Koordinat lintang dan bujur harus diisi bersama';
  end if;
  if p_attendance_latitude is not null and
    (p_attendance_latitude not between -90 and 90 or p_attendance_longitude not between -180 and 180)
  then raise exception 'Koordinat lokasi usaha tidak valid'; end if;
  if coalesce(p_attendance_radius_m,100) not between 20 and 1000 then
    raise exception 'Radius absensi harus 20 sampai 1000 meter';
  end if;
  update public.tenants set
    name=trim(p_name),legal_name=nullif(trim(p_legal_name),''),
    phone=nullif(trim(p_phone),''),email=nullif(lower(trim(p_email)),''),
    address=nullif(trim(p_address),''),tax_id=nullif(trim(p_tax_id),''),
    receipt_footer=coalesce(nullif(trim(p_receipt_footer),''),'Terima kasih telah berbelanja.'),
    logo_url=nullif(trim(p_logo_url),''),attendance_latitude=p_attendance_latitude,
    attendance_longitude=p_attendance_longitude,
    attendance_radius_m=coalesce(p_attendance_radius_m,100),updated_at=now()
  where id=p_tenant_id returning * into v_result;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'BUSINESS_SETTINGS_UPDATED','tenant',p_tenant_id,
    jsonb_build_object('name',v_result.name,'attendanceGeofenceConfigured',v_result.attendance_latitude is not null,
      'attendanceRadiusM',v_result.attendance_radius_m));
  return to_jsonb(v_result);
end $$;

create or replace function public.save_employee_shift_rule_v1(
  p_tenant_id uuid,p_actor_id uuid,p_user_id uuid,p_outlet_id uuid,
  p_effective_from date,p_weekdays smallint[],p_starts_at time,p_ends_at time,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_rule public.employee_shift_rules%rowtype;
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
  update public.employee_shift_rules set active=false,
    effective_until=case when effective_from<p_effective_from then p_effective_from-1 else effective_from end,
    updated_at=now()
  where tenant_id=p_tenant_id and user_id=p_user_id and outlet_id=p_outlet_id and active=true;
  insert into public.employee_shift_rules(
    tenant_id,user_id,outlet_id,effective_from,weekdays,starts_at,ends_at,note,created_by
  ) values(
    p_tenant_id,p_user_id,p_outlet_id,p_effective_from,
    array(select distinct day from unnest(p_weekdays) day order by day),
    p_starts_at,p_ends_at,nullif(trim(coalesce(p_note,'')),''),p_actor_id
  ) returning * into v_rule;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'EMPLOYEE_SHIFT_RULE_UPDATED','employee_shift_rule',v_rule.id,
    jsonb_build_object('userId',p_user_id,'outletId',p_outlet_id,'effectiveFrom',p_effective_from,
      'weekdays',p_weekdays,'startsAt',p_starts_at,'endsAt',p_ends_at));
  return to_jsonb(v_rule);
end $$;

create or replace function public.clock_employee_attendance_v2(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_id uuid,p_device_id uuid,p_action text,
  p_note text,p_latitude numeric,p_longitude numeric,p_accuracy_m numeric,p_photo_path text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_action text:=upper(trim(coalesce(p_action,'')));v_timezone text;v_date date;v_day smallint;
  v_tenant public.tenants%rowtype;v_schedule public.employee_schedules%rowtype;
  v_rule public.employee_shift_rules%rowtype;v_record public.attendance_records%rowtype;
  v_status text:='PRESENT';v_distance numeric;v_start time;
begin
  if not exists(select 1 from profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active) then
    raise exception 'Pengguna aktif tidak ditemukan';
  end if;
  select * into v_tenant from tenants where id=p_tenant_id;
  if v_tenant.attendance_latitude is null or v_tenant.attendance_longitude is null then
    raise exception 'Owner belum mengatur koordinat absensi usaha';
  end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'Lokasi perangkat tidak valid';
  end if;
  if p_accuracy_m is null or p_accuracy_m<0 or p_accuracy_m>greatest(v_tenant.attendance_radius_m,100) then
    raise exception 'Akurasi GPS terlalu rendah. Pindah ke area terbuka lalu coba lagi';
  end if;
  if nullif(trim(coalesce(p_photo_path,'')),'') is null or
    p_photo_path not like p_tenant_id::text||'/attendance/%' then
    raise exception 'Foto wajah absensi wajib diambil dari perangkat ini';
  end if;
  v_distance:=6371000*2*asin(sqrt(
    power(sin(radians((p_latitude-v_tenant.attendance_latitude)/2)),2)+
    cos(radians(v_tenant.attendance_latitude))*cos(radians(p_latitude))*
    power(sin(radians((p_longitude-v_tenant.attendance_longitude)/2)),2)
  ));
  if v_distance>v_tenant.attendance_radius_m then
    raise exception 'Anda berada % meter dari lokasi usaha. Batas absensi % meter',round(v_distance),v_tenant.attendance_radius_m;
  end if;
  select timezone into v_timezone from outlets where id=p_outlet_id and tenant_id=p_tenant_id and active;
  if v_timezone is null then raise exception 'Outlet tidak valid'; end if;
  if not exists(select 1 from profiles p left join user_outlets u on u.user_id=p.user_id and u.outlet_id=p_outlet_id
    where p.user_id=p_actor_id and p.tenant_id=p_tenant_id and (p.role='OWNER' or u.user_id is not null)) then
    raise exception 'Pengguna tidak ditugaskan pada outlet ini';
  end if;
  v_date:=(now() at time zone v_timezone)::date;
  v_day:=extract(isodow from v_date)::smallint;
  select * into v_schedule from employee_schedules
  where tenant_id=p_tenant_id and user_id=p_actor_id and outlet_id=p_outlet_id
    and work_date=v_date and status='SCHEDULED' order by starts_at limit 1;
  if v_schedule.id is null then
    select * into v_rule from employee_shift_rules
    where tenant_id=p_tenant_id and user_id=p_actor_id and outlet_id=p_outlet_id and active=true
      and effective_from<=v_date and (effective_until is null or effective_until>=v_date)
      and v_day=any(weekdays) order by effective_from desc limit 1;
  end if;
  v_start:=coalesce(v_schedule.starts_at,v_rule.starts_at);
  select * into v_record from attendance_records
    where tenant_id=p_tenant_id and user_id=p_actor_id and clock_out_at is null
    order by clock_in_at desc limit 1 for update;
  if v_action='CLOCK_IN' then
    if v_record.id is not null then raise exception 'Absensi masuk masih aktif'; end if;
    if v_start is not null and (now() at time zone v_timezone)::time>v_start+interval '15 minutes' then v_status:='LATE'; end if;
    insert into attendance_records(tenant_id,user_id,outlet_id,schedule_id,work_date,clock_in_at,
      clock_in_device_id,status,note,clock_in_latitude,clock_in_longitude,clock_in_accuracy_m,
      clock_in_distance_m,clock_in_photo_path)
    values(p_tenant_id,p_actor_id,p_outlet_id,v_schedule.id,v_date,now(),p_device_id,v_status,
      nullif(trim(coalesce(p_note,'')),''),p_latitude,p_longitude,p_accuracy_m,v_distance,p_photo_path)
    returning * into v_record;
  elsif v_action='CLOCK_OUT' then
    if v_record.id is null then raise exception 'Belum ada absensi masuk aktif'; end if;
    update attendance_records set clock_out_at=now(),clock_out_device_id=p_device_id,status='COMPLETED',
      note=coalesce(nullif(trim(coalesce(p_note,'')),''),note),clock_out_latitude=p_latitude,
      clock_out_longitude=p_longitude,clock_out_accuracy_m=p_accuracy_m,clock_out_distance_m=v_distance,
      clock_out_photo_path=p_photo_path where id=v_record.id returning * into v_record;
  else raise exception 'Aksi absensi tidak valid'; end if;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when v_action='CLOCK_IN' then 'ATTENDANCE_CLOCKED_IN' else 'ATTENDANCE_CLOCKED_OUT' end,
    'attendance',v_record.id,jsonb_build_object('outletId',p_outlet_id,'deviceId',p_device_id,
      'distanceM',round(v_distance,2),'accuracyM',p_accuracy_m,'photoCaptured',true,'status',v_record.status));
  return jsonb_build_object('id',v_record.id,'workDate',v_record.work_date,
    'clockInAt',v_record.clock_in_at,'clockOutAt',v_record.clock_out_at,'status',v_record.status,
    'distanceM',round(v_distance,2),'photoCaptured',true);
end $$;

revoke all on function public.save_business_settings_v2(uuid,uuid,text,text,text,text,text,text,text,text,numeric,numeric,integer) from public,anon,authenticated;
revoke all on function public.save_employee_shift_rule_v1(uuid,uuid,uuid,uuid,date,smallint[],time,time,text) from public,anon,authenticated;
revoke all on function public.clock_employee_attendance_v2(uuid,uuid,uuid,uuid,text,text,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.save_business_settings_v2(uuid,uuid,text,text,text,text,text,text,text,text,numeric,numeric,integer) to service_role;
grant execute on function public.save_employee_shift_rule_v1(uuid,uuid,uuid,uuid,date,smallint[],time,time,text) to service_role;
grant execute on function public.clock_employee_attendance_v2(uuid,uuid,uuid,uuid,text,text,numeric,numeric,numeric,text) to service_role;
