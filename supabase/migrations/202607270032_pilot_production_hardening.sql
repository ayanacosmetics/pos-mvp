-- Kasir Nusa POS v2.0 - pilot production readiness and hardening
-- Stores UAT evidence, incidents, privacy-safe telemetry and recovery drills.

create table if not exists public.pilot_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id),
  name text not null,
  status text not null default 'DRAFT'
    check(status in ('DRAFT','ACTIVE','PASSED','NEEDS_REVISION','CANCELLED')),
  planned_start date not null,
  planned_end date not null,
  notes text,
  created_by uuid not null references public.profiles(user_id),
  decided_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  decided_at timestamptz,
  check(planned_end>=planned_start)
);

create table if not exists public.pilot_check_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pilot_run_id uuid not null references public.pilot_runs(id) on delete cascade,
  category text not null,
  check_code text not null,
  label text not null,
  status text not null default 'PENDING'
    check(status in ('PENDING','PASSED','FAILED','NOT_APPLICABLE')),
  evidence_note text,
  tested_by uuid references public.profiles(user_id),
  tested_at timestamptz,
  unique(pilot_run_id,check_code)
);

create table if not exists public.production_incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id),
  pilot_run_id uuid references public.pilot_runs(id) on delete set null,
  category text not null
    check(category in ('POS','PAYMENT','STOCK','SYNC','PRINTER','SCANNER','PERFORMANCE','DATA','OTHER')),
  severity text not null check(severity in ('LOW','MEDIUM','HIGH','CRITICAL')),
  status text not null default 'OPEN' check(status in ('OPEN','INVESTIGATING','RESOLVED','CLOSED')),
  title text not null,
  description text not null,
  reproduction_steps text,
  expected_result text,
  actual_result text,
  resolution_note text,
  reported_by uuid not null references public.profiles(user_id),
  resolved_by uuid references public.profiles(user_id),
  reported_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.production_telemetry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid references public.outlets(id),
  user_id uuid references public.profiles(user_id) on delete set null,
  device_id uuid,
  event_type text not null check(event_type in ('SLOW_REQUEST','HTTP_ERROR','NETWORK_ERROR','CLIENT_ERROR')),
  endpoint text not null,
  status_code integer,
  duration_ms integer check(duration_ms is null or duration_ms>=0),
  detail_json jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create table if not exists public.recovery_drills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  backup_export_id uuid not null references public.backup_exports(id),
  result text not null check(result in ('PASSED','FAILED')),
  checksum_verified boolean not null default false,
  procedure_reviewed boolean not null default false,
  row_count bigint not null default 0,
  notes text,
  performed_by uuid not null references public.profiles(user_id),
  performed_at timestamptz not null default now()
);

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'pilot_runs','pilot_check_results','production_incidents',
    'production_telemetry','recovery_drills'
  ] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('drop policy if exists tenant_isolation on public.%I',v_table);
    execute format(
      'create policy tenant_isolation on public.%I for all to authenticated using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id())',
      v_table
    );
  end loop;
end $$;

create index if not exists pilot_runs_recent_idx on public.pilot_runs(tenant_id,created_at desc);
create index if not exists pilot_checks_status_idx on public.pilot_check_results(pilot_run_id,status,category);
create index if not exists production_incidents_open_idx on public.production_incidents(tenant_id,status,severity,reported_at desc);
create index if not exists production_telemetry_recent_idx on public.production_telemetry(tenant_id,occurred_at desc,event_type);
create index if not exists recovery_drills_recent_idx on public.recovery_drills(tenant_id,performed_at desc);

create or replace function public.start_pilot_run_v1(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_id uuid,p_name text,
  p_start date,p_end date,p_notes text default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text;v_pilot uuid;v_check jsonb;v_count integer:=0;
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if v_role is distinct from 'OWNER' then raise exception 'Hanya Owner yang dapat memulai pilot produksi'; end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active)
    then raise exception 'Outlet pilot tidak valid';
  end if;
  if nullif(trim(p_name),'') is null or p_start is null or p_end is null or p_end<p_start
    then raise exception 'Nama dan periode pilot tidak valid';
  end if;
  if exists(select 1 from public.pilot_runs where tenant_id=p_tenant_id and status='ACTIVE')
    then raise exception 'Usaha masih memiliki pilot aktif';
  end if;
  insert into public.pilot_runs(
    tenant_id,outlet_id,name,status,planned_start,planned_end,notes,created_by,activated_at
  ) values(
    p_tenant_id,p_outlet_id,trim(p_name),'ACTIVE',p_start,p_end,nullif(trim(p_notes),''),p_actor_id,now()
  ) returning id into v_pilot;

  for v_check in select value from jsonb_array_elements('[
    {"category":"PERSIAPAN","code":"BUSINESS_IDENTITY","label":"Identitas usaha dan pesan struk sudah benar"},
    {"category":"PERSIAPAN","code":"OUTLET_DEVICE","label":"Outlet, gudang, dan perangkat kasir terdaftar"},
    {"category":"PERSIAPAN","code":"ROLE_ACCESS","label":"Hak akses akun sesuai pekerjaan dan outlet"},
    {"category":"PERSIAPAN","code":"SYSTEM_HEALTH","label":"Kesehatan sistem tanpa temuan kritis"},
    {"category":"PRODUK_HARGA","code":"BARCODE_UNIT","label":"Barcode pcs, lusin, dan karton menghasilkan barang/jumlah benar"},
    {"category":"PRODUK_HARGA","code":"PRICE_PROMO","label":"Harga ecer, grosir, bertingkat, dan promo sesuai"},
    {"category":"PRODUK_HARGA","code":"MANUAL_APPROVAL","label":"Diskon/harga manual meminta persetujuan dan diaudit"},
    {"category":"PENJUALAN","code":"SHIFT_OPEN_CLOSE","label":"Shift buka/tutup dan selisih kas benar"},
    {"category":"PENJUALAN","code":"PAYMENT_METHODS","label":"Tunai, non-tunai, split, dan kembalian benar"},
    {"category":"PENJUALAN","code":"HOLD_RECEIPT","label":"Tahan transaksi dan struk tidak menggandakan penjualan"},
    {"category":"STOK","code":"PURCHASE_RECEIPT","label":"PO dan penerimaan menambah stok lokasi yang benar"},
    {"category":"STOK","code":"TRANSFER_FLOW","label":"Transfer bertahap menjaga stok asal, perjalanan, dan tujuan"},
    {"category":"STOK","code":"COUNT_FEFO","label":"Opname diaudit dan produk EXP memakai FEFO"},
    {"category":"RETUR_REKENING","code":"CUSTOMER_RETURN","label":"Retur pelanggan dan refund berdampak benar"},
    {"category":"RETUR_REKENING","code":"SUPPLIER_RETURN","label":"Retur supplier dan nota kredit berdampak benar"},
    {"category":"RETUR_REKENING","code":"DEBT_PAYMENT","label":"Pembayaran piutang/hutang mengurangi saldo dan jurnal"},
    {"category":"OFFLINE","code":"OFFLINE_SALE","label":"Transaksi offline tersimpan dan tersinkron tanpa duplikasi"},
    {"category":"OFFLINE","code":"SYNC_CONFLICT","label":"Konflik sinkronisasi dapat diputuskan supervisor"},
    {"category":"OFFLINE","code":"CONCURRENT_STOCK","label":"Dua kasir tidak dapat membuat stok negatif"},
    {"category":"PERANGKAT","code":"PRINTER","label":"Printer mencetak dan dapat cetak ulang"},
    {"category":"PERANGKAT","code":"SCANNER","label":"Scanner Bluetooth mengirim barcode dengan benar"},
    {"category":"PELAPORAN","code":"REPORT_AUDIT","label":"Laporan dan audit sesuai transaksi uji"},
    {"category":"PEMULIHAN","code":"BACKUP_VERIFY","label":"Backup terbaru lolos checksum dan dapat dibaca"},
    {"category":"PEMULIHAN","code":"RECOVERY_DRILL","label":"Prosedur pemulihan ditinjau dan latihan dicatat"},
    {"category":"PEMULIHAN","code":"INCIDENT_SOP","label":"Staf memahami SOP internet, printer, dan sinkronisasi"}
  ]'::jsonb) loop
    insert into public.pilot_check_results(tenant_id,pilot_run_id,category,check_code,label)
    values(p_tenant_id,v_pilot,v_check->>'category',v_check->>'code',v_check->>'label');
    v_count:=v_count+1;
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PILOT_STARTED','pilot_run',v_pilot,
    jsonb_build_object('outletId',p_outlet_id,'start',p_start,'end',p_end,'checkCount',v_count));
  return jsonb_build_object('id',v_pilot,'status','ACTIVE','checkCount',v_count);
end $$;

create or replace function public.update_pilot_check_v1(
  p_tenant_id uuid,p_actor_id uuid,p_check_id uuid,p_status text,p_evidence text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text;v_check public.pilot_check_results%rowtype;v_status text:=upper(trim(p_status));
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if v_role is distinct from 'OWNER' then raise exception 'Hanya Owner yang dapat mengisi checklist pilot'; end if;
  if v_status not in ('PENDING','PASSED','FAILED','NOT_APPLICABLE') then raise exception 'Status checklist tidak valid'; end if;
  update public.pilot_check_results set status=v_status,evidence_note=nullif(trim(p_evidence),''),
    tested_by=case when v_status='PENDING' then null else p_actor_id end,
    tested_at=case when v_status='PENDING' then null else now() end
  where id=p_check_id and tenant_id=p_tenant_id returning * into v_check;
  if not found then raise exception 'Checklist pilot tidak ditemukan'; end if;
  if not exists(select 1 from public.pilot_runs where id=v_check.pilot_run_id and status='ACTIVE')
    then raise exception 'Pilot tidak aktif';
  end if;
  return jsonb_build_object('id',v_check.id,'status',v_status);
end $$;

create or replace function public.decide_pilot_run_v1(
  p_tenant_id uuid,p_actor_id uuid,p_pilot_id uuid,p_decision text,p_notes text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_role text;v_decision text:=upper(trim(p_decision));v_pending integer;v_failed integer;
  v_blocking integer;v_health jsonb;v_safety jsonb;
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if v_role is distinct from 'OWNER' then raise exception 'Hanya Owner yang dapat memutuskan hasil pilot'; end if;
  if v_decision not in ('PASSED','NEEDS_REVISION','CANCELLED') then raise exception 'Keputusan pilot tidak valid'; end if;
  if not exists(select 1 from public.pilot_runs where id=p_pilot_id and tenant_id=p_tenant_id and status='ACTIVE')
    then raise exception 'Pilot aktif tidak ditemukan';
  end if;
  select count(*) filter(where status='PENDING'),count(*) filter(where status='FAILED')
    into v_pending,v_failed from public.pilot_check_results where pilot_run_id=p_pilot_id;
  select count(*) into v_blocking from public.production_incidents
    where tenant_id=p_tenant_id and pilot_run_id=p_pilot_id
      and severity in ('HIGH','CRITICAL') and status not in ('RESOLVED','CLOSED');
  if v_decision='PASSED' then
    if v_pending>0 or v_failed>0 then
      raise exception 'Pilot belum dapat diluluskan: masih ada checklist tertunda atau gagal';
    end if;
    if v_blocking>0 then raise exception 'Pilot belum dapat diluluskan: insiden tinggi atau kritis masih terbuka'; end if;
    v_health:=public.operational_health_check(p_tenant_id,p_actor_id);
    v_safety:=public.pilot_safety_readiness_v1(p_tenant_id,p_actor_id);
    if v_health->>'status'='CRITICAL' then raise exception 'Pilot belum dapat diluluskan: kesehatan sistem kritis'; end if;
    if coalesce((v_safety->>'ready')::boolean,false)=false then raise exception 'Pilot belum dapat diluluskan: kontrol transaksi belum siap'; end if;
  end if;
  update public.pilot_runs set status=v_decision,notes=coalesce(nullif(trim(p_notes),''),notes),
    decided_by=p_actor_id,decided_at=now() where id=p_pilot_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'PILOT_'||v_decision,'pilot_run',p_pilot_id,
    jsonb_build_object('pending',v_pending,'failed',v_failed,'blockingIncidents',v_blocking,'notes',nullif(trim(p_notes),'')));
  return jsonb_build_object('id',p_pilot_id,'status',v_decision,'pending',v_pending,'failed',v_failed,'blockingIncidents',v_blocking);
end $$;

create or replace function public.pilot_safety_readiness_v1(
  p_tenant_id uuid,p_actor_id uuid
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_role text;v_negative integer;v_sale_idempotency boolean;v_ledger_idempotency boolean;v_sale_rpc boolean;
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if v_role is distinct from 'OWNER' then raise exception 'Hanya Owner yang dapat memeriksa kontrol transaksi'; end if;
  select count(*) into v_negative from public.stock_balances where tenant_id=p_tenant_id and quantity<0;
  select exists(select 1 from pg_constraint where conrelid='public.sales'::regclass and contype='u'
    and pg_get_constraintdef(oid) ilike '%tenant_id%idempotency_key%') into v_sale_idempotency;
  select exists(select 1 from pg_constraint where conrelid='public.stock_ledger'::regclass and contype='u'
    and pg_get_constraintdef(oid) ilike '%tenant_id%idempotency_key%') into v_ledger_idempotency;
  select to_regprocedure('public.complete_sale_v7(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text,text,text)') is not null
    into v_sale_rpc;
  return jsonb_build_object(
    'ready',v_negative=0 and v_sale_idempotency and v_ledger_idempotency and v_sale_rpc,
    'negativeStock',v_negative,'saleIdempotency',v_sale_idempotency,
    'ledgerIdempotency',v_ledger_idempotency,'atomicSaleRpc',v_sale_rpc,
    'rowLockControl','complete_sale_v7 locks stock balance rows and rejects insufficient quantity'
  );
end $$;

create or replace function public.purge_old_telemetry_v1(
  p_tenant_id uuid,p_actor_id uuid,p_retention_days integer default 30
) returns integer
language plpgsql security definer set search_path=public as $$
declare v_role text;v_deleted integer;
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active;
  if v_role is distinct from 'OWNER' then raise exception 'Hanya Owner yang dapat membersihkan telemetri'; end if;
  if p_retention_days not between 7 and 365 then raise exception 'Retensi harus 7 sampai 365 hari'; end if;
  delete from public.production_telemetry where tenant_id=p_tenant_id
    and occurred_at<now()-make_interval(days=>p_retention_days);
  get diagnostics v_deleted=row_count;
  return v_deleted;
end $$;

revoke all on function public.start_pilot_run_v1(uuid,uuid,uuid,text,date,date,text) from public,anon,authenticated;
revoke all on function public.update_pilot_check_v1(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.decide_pilot_run_v1(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.pilot_safety_readiness_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.purge_old_telemetry_v1(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.start_pilot_run_v1(uuid,uuid,uuid,text,date,date,text) to service_role;
grant execute on function public.update_pilot_check_v1(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.decide_pilot_run_v1(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.pilot_safety_readiness_v1(uuid,uuid) to service_role;
grant execute on function public.purge_old_telemetry_v1(uuid,uuid,integer) to service_role;
