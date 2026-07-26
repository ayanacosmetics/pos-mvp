-- Kasir Nusa POS v1.25 - employee operations, multi-level approval, and shift reconciliation
create table if not exists public.employee_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  work_date date not null,
  starts_at time not null,
  ends_at time not null,
  status text not null default 'SCHEDULED' check(status in ('SCHEDULED','CANCELLED')),
  note text,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(ends_at > starts_at),
  unique(tenant_id,user_id,work_date,starts_at)
);

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  outlet_id uuid not null references public.outlets(id) on delete cascade,
  schedule_id uuid references public.employee_schedules(id) on delete set null,
  work_date date not null,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  clock_in_device_id uuid,
  clock_out_device_id uuid,
  status text not null default 'PRESENT' check(status in ('PRESENT','LATE','COMPLETED','ADJUSTED')),
  note text,
  approved_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now()
);
create unique index if not exists one_open_attendance_per_employee
  on public.attendance_records(tenant_id,user_id) where clock_out_at is null;
create index if not exists attendance_employee_date_idx
  on public.attendance_records(tenant_id,user_id,work_date desc);

create table if not exists public.employee_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  outlet_id uuid references public.outlets(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  sales_target numeric(19,4) not null default 0 check(sales_target >= 0),
  transaction_target integer not null default 0 check(transaction_target >= 0),
  commission_type text not null default 'SALES_PERCENT'
    check(commission_type in ('SALES_PERCENT','FIXED_PER_TRANSACTION')),
  commission_value numeric(19,4) not null default 0 check(commission_value >= 0),
  active boolean not null default true,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(period_end >= period_start),
  unique(tenant_id,user_id,outlet_id,period_start,period_end)
);
create unique index if not exists employee_targets_all_outlets_unique
  on public.employee_targets(tenant_id,user_id,period_start,period_end)
  where outlet_id is null;

create table if not exists public.approval_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  action_type text not null check(action_type in ('DISCOUNT','VOID','PURCHASE','STOCK_COUNT')),
  minimum_amount numeric(19,4) not null default 0 check(minimum_amount >= 0),
  required_levels integer not null default 1 check(required_levels between 1 and 2),
  active boolean not null default true,
  updated_by uuid not null references public.profiles(user_id),
  updated_at timestamptz not null default now(),
  unique(tenant_id,action_type,minimum_amount)
);

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id) on delete cascade,
  requester_id uuid not null references public.profiles(user_id),
  action_type text not null check(action_type in ('DISCOUNT','VOID','PURCHASE','STOCK_COUNT')),
  entity_type text,
  entity_id uuid,
  amount numeric(19,4) not null default 0 check(amount >= 0),
  reason text not null check(length(reason) >= 5),
  required_levels integer not null default 1 check(required_levels between 1 and 2),
  current_level integer not null default 0 check(current_level between 0 and 2),
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decisions_json jsonb not null default '[]'::jsonb,
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists approval_request_queue_idx
  on public.approval_requests(tenant_id,status,requested_at desc);

create table if not exists public.shift_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  payment_method text not null,
  expected_amount numeric(19,4) not null,
  declared_amount numeric(19,4) not null,
  difference numeric(19,4) not null,
  reconciled_by uuid not null references public.profiles(user_id),
  reconciled_at timestamptz not null default now(),
  unique(tenant_id,shift_id,payment_method)
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'employee_schedules','attendance_records','employee_targets',
    'approval_policies','approval_requests','shift_reconciliations'
  ] loop
    execute format('alter table public.%I enable row level security',table_name);
    if not exists(
      select 1 from pg_policies where schemaname='public' and tablename=table_name
        and policyname=table_name||'_tenant_read'
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using(tenant_id=public.current_tenant_id())',
        table_name||'_tenant_read',table_name
      );
    end if;
  end loop;
end $$;

create or replace function public.clock_employee_attendance(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_id uuid,p_device_id uuid,
  p_action text,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_action text:=upper(trim(coalesce(p_action,'')));
  v_timezone text;v_date date;v_schedule public.employee_schedules%rowtype;
  v_record public.attendance_records%rowtype;v_status text:='PRESENT';
begin
  if not exists(select 1 from profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active) then
    raise exception 'Pengguna aktif tidak ditemukan';
  end if;
  select timezone into v_timezone from outlets where id=p_outlet_id and tenant_id=p_tenant_id and active;
  if v_timezone is null then raise exception 'Outlet tidak valid'; end if;
  if not exists(
    select 1 from profiles p left join user_outlets u on u.user_id=p.user_id and u.outlet_id=p_outlet_id
    where p.user_id=p_actor_id and p.tenant_id=p_tenant_id and (p.role='OWNER' or u.user_id is not null)
  ) then raise exception 'Pengguna tidak ditugaskan pada outlet ini'; end if;
  v_date:=(now() at time zone v_timezone)::date;
  select * into v_schedule from employee_schedules
    where tenant_id=p_tenant_id and user_id=p_actor_id and outlet_id=p_outlet_id
      and work_date=v_date and status='SCHEDULED'
    order by starts_at limit 1;
  select * into v_record from attendance_records
    where tenant_id=p_tenant_id and user_id=p_actor_id and clock_out_at is null
    order by clock_in_at desc limit 1 for update;
  if v_action='CLOCK_IN' then
    if v_record.id is not null then raise exception 'Absensi masuk masih aktif'; end if;
    if v_schedule.id is not null and (now() at time zone v_timezone)::time > v_schedule.starts_at + interval '15 minutes'
      then v_status:='LATE'; end if;
    insert into attendance_records(
      tenant_id,user_id,outlet_id,schedule_id,work_date,clock_in_at,
      clock_in_device_id,status,note
    ) values(
      p_tenant_id,p_actor_id,p_outlet_id,v_schedule.id,v_date,now(),
      p_device_id,v_status,nullif(trim(coalesce(p_note,'')),'')
    ) returning * into v_record;
    insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
      values(p_tenant_id,p_actor_id,'ATTENDANCE_CLOCKED_IN','attendance',v_record.id,
        jsonb_build_object('outletId',p_outlet_id,'deviceId',p_device_id,'status',v_status));
  elsif v_action='CLOCK_OUT' then
    if v_record.id is null then raise exception 'Belum ada absensi masuk aktif'; end if;
    update attendance_records set clock_out_at=now(),clock_out_device_id=p_device_id,status='COMPLETED',
      note=coalesce(nullif(trim(coalesce(p_note,'')),''),note)
      where id=v_record.id returning * into v_record;
    insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
      values(p_tenant_id,p_actor_id,'ATTENDANCE_CLOCKED_OUT','attendance',v_record.id,
        jsonb_build_object('outletId',v_record.outlet_id,'deviceId',p_device_id));
  else raise exception 'Aksi absensi tidak valid';
  end if;
  return jsonb_build_object(
    'id',v_record.id,'workDate',v_record.work_date,'clockInAt',v_record.clock_in_at,
    'clockOutAt',v_record.clock_out_at,'status',v_record.status
  );
end $$;

create or replace function public.decide_approval_request(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_decision text,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_request public.approval_requests%rowtype;v_role text;v_decision text:=upper(trim(p_decision));
begin
  select role into v_role from profiles where user_id=p_actor_id and tenant_id=p_tenant_id and active;
  if v_role not in ('OWNER','ADMIN') then raise exception 'Hanya Owner/Admin yang dapat menyetujui'; end if;
  select * into v_request from approval_requests
    where id=p_request_id and tenant_id=p_tenant_id for update;
  if v_request.id is null then raise exception 'Permintaan persetujuan tidak ditemukan'; end if;
  if v_request.status<>'PENDING' then raise exception 'Permintaan sudah diputuskan'; end if;
  if v_request.requester_id=p_actor_id then raise exception 'Pemohon tidak dapat menyetujui permintaan sendiri'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_request.decisions_json) item
    where item->>'actorId'=p_actor_id::text
  ) then raise exception 'Approver yang sama tidak boleh menyetujui dua tingkat'; end if;
  if v_decision='REJECT' then
    update approval_requests set status='REJECTED',decided_at=now(),
      decisions_json=decisions_json||jsonb_build_array(jsonb_build_object(
        'level',current_level+1,'actorId',p_actor_id,'decision','REJECT','note',trim(coalesce(p_note,'')),'at',now()
      )) where id=v_request.id;
  elsif v_decision='APPROVE' then
    update approval_requests set current_level=current_level+1,
      status=case when current_level+1>=required_levels then 'APPROVED' else 'PENDING' end,
      decided_at=case when current_level+1>=required_levels then now() else null end,
      decisions_json=decisions_json||jsonb_build_array(jsonb_build_object(
        'level',current_level+1,'actorId',p_actor_id,'decision','APPROVE','note',trim(coalesce(p_note,'')),'at',now()
      )) where id=v_request.id;
  else raise exception 'Keputusan tidak valid'; end if;
  select * into v_request from approval_requests where id=p_request_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'APPROVAL_REQUEST_DECIDED','approval_request',v_request.id,
      jsonb_build_object('decision',v_decision,'status',v_request.status,'level',v_request.current_level));
  return jsonb_build_object('id',v_request.id,'status',v_request.status,'currentLevel',v_request.current_level);
end $$;

create or replace function public.close_shift_with_reconciliation(
  p_tenant_id uuid,p_actor_id uuid,p_shift_id uuid,p_declarations jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_shift public.shifts%rowtype;v_item jsonb;v_method text;v_declared numeric;
  v_expected numeric;v_cash_expected numeric;v_cash_declared numeric;v_cash_difference numeric;
begin
  select * into v_shift from shifts where id=p_shift_id and tenant_id=p_tenant_id
    and cashier_id=p_actor_id and status='OPEN' for update;
  if v_shift.id is null then raise exception 'Shift aktif milik pengguna tidak ditemukan'; end if;
  if jsonb_typeof(p_declarations)<>'array' or jsonb_array_length(p_declarations)=0
    then raise exception 'Rekonsiliasi metode pembayaran wajib diisi'; end if;
  delete from shift_reconciliations where tenant_id=p_tenant_id and shift_id=p_shift_id;
  for v_item in select * from jsonb_array_elements(p_declarations) loop
    v_method:=upper(trim(coalesce(v_item->>'method','')));
    if v_method='TUNAI' then v_method:='CASH'; end if;
    v_declared:=coalesce((v_item->>'declaredAmount')::numeric,0);
    if v_method='' or v_declared<0 then raise exception 'Deklarasi pembayaran tidak valid'; end if;
    select coalesce(sum(p.amount),0) into v_expected
      from payments p join sales s on s.id=p.sale_id
      where p.tenant_id=p_tenant_id and s.shift_id=p_shift_id and s.status='COMPLETED'
        and case when upper(p.method) in ('CASH','TUNAI') then 'CASH' else upper(p.method) end=v_method;
    if v_method='CASH' then
      select v_shift.opening_cash+v_expected+coalesce(sum(
        case when movement_type='CASH_IN' then amount else -amount end
      ),0) into v_expected from cash_movements
        where tenant_id=p_tenant_id and shift_id=p_shift_id;
      v_cash_expected:=v_expected;v_cash_declared:=v_declared;v_cash_difference:=v_declared-v_expected;
    end if;
    insert into shift_reconciliations(
      tenant_id,shift_id,payment_method,expected_amount,declared_amount,difference,reconciled_by
    ) values(p_tenant_id,p_shift_id,v_method,v_expected,v_declared,v_declared-v_expected,p_actor_id);
  end loop;
  if v_cash_declared is null then raise exception 'Deklarasi kas tunai wajib diisi'; end if;
  update shifts set status='CLOSED',closed_at=now(),expected_cash=v_cash_expected,
    closing_cash=v_cash_declared,difference=v_cash_difference where id=p_shift_id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'SHIFT_RECONCILED_AND_CLOSED','shift',p_shift_id,
      jsonb_build_object('methods',p_declarations,'cashDifference',v_cash_difference));
  return jsonb_build_object(
    'id',p_shift_id,'status','CLOSED','expectedCash',v_cash_expected,
    'closingCash',v_cash_declared,'difference',v_cash_difference
  );
end $$;

revoke all on function public.clock_employee_attendance(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.decide_approval_request(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.close_shift_with_reconciliation(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.clock_employee_attendance(uuid,uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.decide_approval_request(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.close_shift_with_reconciliation(uuid,uuid,uuid,jsonb) to service_role;
