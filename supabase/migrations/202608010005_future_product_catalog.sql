-- Future-safe catalog families, shared barcodes, flexible SKU options, and
-- the pending editable recurring schedule function in one deployable migration.

begin;

create table if not exists public.product_families (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,code)
);
create unique index if not exists product_families_name_unique_idx
  on public.product_families(tenant_id,lower(name));

alter table public.products add column if not exists family_id uuid references public.product_families(id) on delete set null;
alter table public.products add column if not exists legacy_code text;
create index if not exists products_family_idx on public.products(tenant_id,family_id) where family_id is not null;
create index if not exists products_legacy_code_idx on public.products(tenant_id,legacy_code) where legacy_code is not null;

create table if not exists public.product_family_barcodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  family_id uuid not null references public.product_families(id) on delete cascade,
  barcode text not null,
  created_at timestamptz not null default now(),
  unique(tenant_id,barcode),
  unique(family_id,barcode)
);

create table if not exists public.product_variant_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  option_name text not null,
  option_value text not null,
  position smallint not null default 1 check(position between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists product_variant_options_name_unique_idx
  on public.product_variant_options(product_id,lower(option_name));
create index if not exists product_variant_options_tenant_idx
  on public.product_variant_options(tenant_id,product_id,position);

alter table public.product_families enable row level security;
alter table public.product_family_barcodes enable row level security;
alter table public.product_variant_options enable row level security;
grant select,insert,update,delete on public.product_families to service_role;
grant select,insert,update,delete on public.product_family_barcodes to service_role;
grant select,insert,update,delete on public.product_variant_options to service_role;

-- A barcode has exactly one meaning inside a tenant: either a direct SKU/unit
-- barcode or a family barcode that intentionally asks the cashier to choose.
create or replace function public.enforce_catalog_barcode_ownership_v1()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_table_name='product_family_barcodes' then
    if exists(select 1 from public.product_units u where u.tenant_id=new.tenant_id and u.barcode=new.barcode) then
      raise exception 'Barcode % sudah dipakai langsung oleh SKU',new.barcode;
    end if;
  elsif new.barcode is not null and trim(new.barcode)<>'' and exists(
    select 1 from public.product_family_barcodes b where b.tenant_id=new.tenant_id and b.barcode=new.barcode
  ) then
    raise exception 'Barcode % adalah barcode bersama etalase',new.barcode;
  end if;
  return new;
end $$;

drop trigger if exists product_family_barcode_ownership_v1 on public.product_family_barcodes;
create trigger product_family_barcode_ownership_v1 before insert or update of tenant_id,barcode
on public.product_family_barcodes for each row execute function public.enforce_catalog_barcode_ownership_v1();
drop trigger if exists product_unit_barcode_ownership_v1 on public.product_units;
create trigger product_unit_barcode_ownership_v1 before insert or update of tenant_id,barcode
on public.product_units for each row execute function public.enforce_catalog_barcode_ownership_v1();

-- Preserve existing flat variant metadata without touching SKU identity,
-- stock, cost, or transaction history.
insert into public.product_families(tenant_id,code,name)
select distinct p.tenant_id,'LEGACY-'||upper(substr(md5(lower(trim(p.variant_group))),1,12)),trim(p.variant_group)
from public.products p
where nullif(trim(p.variant_group),'') is not null
on conflict do nothing;

update public.products p set family_id=f.id
from public.product_families f
where p.tenant_id=f.tenant_id and p.family_id is null
  and nullif(trim(p.variant_group),'') is not null
  and lower(trim(p.variant_group))=lower(f.name);

insert into public.product_variant_options(tenant_id,product_id,option_name,option_value,position)
select p.tenant_id,p.id,'Varian',trim(p.variant_name),1
from public.products p
where p.family_id is not null and nullif(trim(p.variant_name),'') is not null
on conflict do nothing;

alter table public.import_jobs drop constraint if exists import_jobs_import_kind_check;
alter table public.import_jobs add constraint import_jobs_import_kind_check check(import_kind in(
  'PRODUCTS','PRODUCT_FAMILIES','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_OPTIONS','PRODUCT_PRICES',
  'KASPIN_FIFO','KASPIN_SALES','CUSTOMERS','SUPPLIERS'
));

create or replace function public.import_product_catalog_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_kind text,p_file_name text,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_job public.import_jobs%rowtype;v_row jsonb;v_family public.product_families%rowtype;
  v_product public.products%rowtype;v_code text;v_name text;v_barcode text;v_sku text;
  v_option_name text;v_option_value text;v_position smallint;v_created integer:=0;v_updated integer:=0;
begin
  p_kind:=upper(coalesce(p_kind,''));
  if p_kind not in('PRODUCT_FAMILIES','PRODUCT_VARIANTS','PRODUCT_OPTIONS') then raise exception 'Jenis katalog tidak valid';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 or jsonb_array_length(p_rows)>500 then raise exception 'Data harus berisi 1 sampai 500 baris';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN')) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor katalog';end if;
  select * into v_job from public.import_jobs where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if p_kind='PRODUCT_FAMILIES' then
      v_code:=upper(trim(v_row->>'familyCode'));v_name:=trim(v_row->>'familyName');v_barcode:=nullif(trim(v_row->>'sharedBarcode'),'');
      if v_code='' or v_name='' then raise exception 'Kode dan nama etalase wajib diisi';end if;
      if v_barcode is not null and exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode) then raise exception 'Barcode % sudah dipakai langsung oleh SKU',v_barcode;end if;
      select * into v_family from public.product_families where tenant_id=p_tenant_id and code=v_code for update;
      if found then
        update public.product_families set name=v_name,active=true,updated_at=now() where id=v_family.id returning * into v_family;v_updated:=v_updated+1;
      else
        insert into public.product_families(tenant_id,code,name) values(p_tenant_id,v_code,v_name) returning * into v_family;v_created:=v_created+1;
      end if;
      if v_barcode is null then delete from public.product_family_barcodes where family_id=v_family.id;
      else
        if exists(select 1 from public.product_family_barcodes where tenant_id=p_tenant_id and barcode=v_barcode and family_id<>v_family.id) then raise exception 'Barcode bersama % sudah dipakai etalase lain',v_barcode;end if;
        delete from public.product_family_barcodes where family_id=v_family.id and barcode<>v_barcode;
        insert into public.product_family_barcodes(tenant_id,family_id,barcode) values(p_tenant_id,v_family.id,v_barcode) on conflict(family_id,barcode) do nothing;
      end if;
    elsif p_kind='PRODUCT_VARIANTS' then
      v_sku:=upper(trim(v_row->>'sku'));v_code:=upper(trim(v_row->>'familyCode'));v_name:=trim(v_row->>'variantGroup');
      select * into v_product from public.products where tenant_id=p_tenant_id and sku=v_sku for update;
      if not found then raise exception 'SKU % belum ada',v_sku;end if;
      select * into v_family from public.product_families where tenant_id=p_tenant_id and code=v_code for update;
      if not found then insert into public.product_families(tenant_id,code,name) values(p_tenant_id,v_code,v_name) returning * into v_family;v_created:=v_created+1;
      elsif lower(v_family.name)<>lower(v_name) then raise exception 'Kode etalase % sudah bernama %',v_code,v_family.name;end if;
      update public.products set family_id=v_family.id,variant_group=v_family.name,variant_name=trim(v_row->>'variantName'),updated_at=now() where id=v_product.id;
      v_updated:=v_updated+1;
    else
      v_sku:=upper(trim(v_row->>'sku'));v_option_name:=trim(v_row->>'optionName');v_option_value:=trim(v_row->>'optionValue');v_position:=coalesce((v_row->>'position')::smallint,1);
      select * into v_product from public.products where tenant_id=p_tenant_id and sku=v_sku for update;
      if not found then raise exception 'SKU % belum ada',v_sku;end if;
      if v_product.family_id is null then raise exception 'SKU % belum dipetakan ke etalase',v_sku;end if;
      if exists(select 1 from public.product_variant_options where product_id=v_product.id and lower(option_name)=lower(v_option_name)) then
        update public.product_variant_options set option_name=v_option_name,option_value=v_option_value,position=v_position,updated_at=now() where product_id=v_product.id and lower(option_name)=lower(v_option_name);v_updated:=v_updated+1;
      else
        insert into public.product_variant_options(tenant_id,product_id,option_name,option_value,position) values(p_tenant_id,v_product.id,v_option_name,v_option_value,v_position);v_created:=v_created+1;
      end if;
    end if;
  end loop;

  insert into public.import_jobs(tenant_id,actor_id,idempotency_key,import_kind,file_name,total_rows,created_rows,updated_rows,summary_json)
  values(p_tenant_id,p_actor_id,p_idempotency_key,p_kind,nullif(p_file_name,''),jsonb_array_length(p_rows),v_created,v_updated,
    jsonb_build_object('kind',p_kind,'total',jsonb_array_length(p_rows),'created',v_created,'updated',v_updated)) returning * into v_job;
  update public.import_jobs set summary_json=summary_json||jsonb_build_object('id',v_job.id) where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,p_kind||'_IMPORTED','import_job',v_job.id,jsonb_build_object('fileName',p_file_name,'created',v_created,'updated',v_updated));
  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end $$;

revoke all on function public.import_product_catalog_v1(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.import_product_catalog_v1(uuid,uuid,text,text,text,jsonb) to service_role;

create or replace function public.apply_import_product_settings_v1(p_tenant_id uuid,p_actor_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Akses ditolak';end if;
  update public.products p set minimum_stock=coalesce((r.value->>'minimumStock')::numeric,0),track_expiry=coalesce((r.value->>'trackExpiry')::boolean,false),legacy_code=nullif(trim(r.value->>'legacyCode'),''),updated_at=now()
  from jsonb_array_elements(p_rows) r where p.tenant_id=p_tenant_id and p.sku=upper(trim(r.value->>'sku'));
  get diagnostics v_count=row_count;return v_count;
end $$;

create or replace function public.reset_tenant_data_v2(p_tenant_id uuid,p_actor_id uuid,p_scopes text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;v_scopes text[]:=array(select distinct upper(value) from unnest(coalesce(p_scopes,'{}')) value);
begin
  v_result:=public.reset_tenant_data_v1(p_tenant_id,p_actor_id,p_scopes);
  if 'ALL'=any(v_scopes) or 'CATALOG'=any(v_scopes) then
    delete from public.product_family_barcodes where tenant_id=p_tenant_id;
    delete from public.product_families where tenant_id=p_tenant_id;
  end if;
  return v_result||jsonb_build_object('catalogFamiliesReset',('ALL'=any(v_scopes) or 'CATALOG'=any(v_scopes)));
end $$;
revoke all on function public.reset_tenant_data_v2(uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.reset_tenant_data_v2(uuid,uuid,text[]) to service_role;

-- Restore old and new backups atomically. Product family references are
-- detached while the established v1 restore rebuilds the operational graph,
-- then restored after their parent families exist.
create or replace function public.restore_tenant_backup_v2(p_tenant_id uuid,p_actor_id uuid,p_tables jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;v_tables jsonb:=coalesce(p_tables,'{}'::jsonb);v_products jsonb;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and role='OWNER' and active) then raise exception 'Hanya Owner aktif yang dapat memulihkan backup';end if;
  v_products:=coalesce(v_tables->'products','[]'::jsonb);
  v_tables:=jsonb_set(v_tables,'{products}',coalesce((select jsonb_agg(value-'family_id') from jsonb_array_elements(v_products)),'[]'::jsonb),true);
  delete from public.product_family_barcodes where tenant_id=p_tenant_id;
  update public.products set family_id=null where tenant_id=p_tenant_id and family_id is not null;
  delete from public.product_families where tenant_id=p_tenant_id;
  v_result:=public.restore_tenant_backup_v1(p_tenant_id,p_actor_id,v_tables);
  insert into public.product_families select row_data.* from jsonb_populate_recordset(null::public.product_families,coalesce(p_tables->'product_families','[]'::jsonb)) row_data where row_data.tenant_id=p_tenant_id;
  update public.products p set family_id=(item->>'family_id')::uuid
  from jsonb_array_elements(v_products) item
  where p.tenant_id=p_tenant_id and p.id=(item->>'id')::uuid and nullif(item->>'family_id','') is not null;
  insert into public.product_family_barcodes select row_data.* from jsonb_populate_recordset(null::public.product_family_barcodes,coalesce(p_tables->'product_family_barcodes','[]'::jsonb)) row_data where row_data.tenant_id=p_tenant_id;
  insert into public.product_variant_options select row_data.* from jsonb_populate_recordset(null::public.product_variant_options,coalesce(p_tables->'product_variant_options','[]'::jsonb)) row_data where row_data.tenant_id=p_tenant_id;
  return v_result||jsonb_build_object('catalogFamiliesRestored',jsonb_array_length(coalesce(p_tables->'product_families','[]'::jsonb)));
end $$;
revoke all on function public.restore_tenant_backup_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.restore_tenant_backup_v2(uuid,uuid,jsonb) to service_role;

create or replace function public.dry_run_restore_tenant_backup_v2(p_tenant_id uuid,p_actor_id uuid,p_tables jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  begin
    v_result:=public.restore_tenant_backup_v2(p_tenant_id,p_actor_id,p_tables);
    raise exception using errcode='ZX001',message='__RESTORE_DRY_RUN_OK__';
  exception when sqlstate 'ZX001' then return jsonb_build_object('valid',true,'restoredRows',coalesce((v_result->>'restoredRows')::bigint,0));
  when others then return jsonb_build_object('valid',false,'error',sqlerrm,'sqlstate',sqlstate);end;
end $$;
revoke all on function public.dry_run_restore_tenant_backup_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dry_run_restore_tenant_backup_v2(uuid,uuid,jsonb) to service_role;

-- Included so this is the only SQL the user needs after the prior candidate.
create or replace function public.save_employee_shift_rule_v2(
  p_tenant_id uuid,p_actor_id uuid,p_rule_id uuid,p_user_id uuid,p_outlet_id uuid,
  p_effective_from date,p_weekdays smallint[],p_starts_at time,p_ends_at time,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_rule public.employee_shift_rules%rowtype;v_existing public.employee_shift_rules%rowtype;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN','MANAGER')) then raise exception 'Anda tidak dapat mengatur jadwal karyawan';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_user_id and active) then raise exception 'Karyawan aktif tidak ditemukan';end if;
  if not exists(select 1 from public.outlets where tenant_id=p_tenant_id and id=p_outlet_id and active) then raise exception 'Outlet tidak valid';end if;
  if p_effective_from is null or p_starts_at is null or p_ends_at is null or p_ends_at<=p_starts_at then raise exception 'Tanggal dan jam shift tidak valid';end if;
  if coalesce(cardinality(p_weekdays),0)<1 or not p_weekdays <@ array[1,2,3,4,5,6,7]::smallint[] then raise exception 'Pilih minimal satu hari kerja';end if;
  if p_rule_id is not null then select * into v_existing from public.employee_shift_rules where id=p_rule_id and tenant_id=p_tenant_id for update;if not found then raise exception 'Jadwal berulang tidak ditemukan';end if;end if;
  if exists(select 1 from public.employee_shift_rules rule where rule.tenant_id=p_tenant_id and rule.user_id=p_user_id and rule.outlet_id=p_outlet_id and rule.active=true and(p_rule_id is null or rule.id<>p_rule_id)and rule.weekdays&&p_weekdays) then raise exception 'Hari kerja bertabrakan dengan jadwal aktif. Edit jadwal tersebut atau pilih hari lain';end if;
  if p_rule_id is null then
    insert into public.employee_shift_rules(tenant_id,user_id,outlet_id,effective_from,weekdays,starts_at,ends_at,note,created_by)
    values(p_tenant_id,p_user_id,p_outlet_id,p_effective_from,array(select distinct day from unnest(p_weekdays) day order by day),p_starts_at,p_ends_at,nullif(trim(coalesce(p_note,'')),''),p_actor_id) returning * into v_rule;
  else
    update public.employee_shift_rules set user_id=p_user_id,outlet_id=p_outlet_id,effective_from=p_effective_from,effective_until=null,weekdays=array(select distinct day from unnest(p_weekdays) day order by day),starts_at=p_starts_at,ends_at=p_ends_at,note=nullif(trim(coalesce(p_note,'')),''),active=true,updated_at=now() where id=p_rule_id returning * into v_rule;
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,case when p_rule_id is null then 'EMPLOYEE_SHIFT_RULE_CREATED' else 'EMPLOYEE_SHIFT_RULE_EDITED' end,'employee_shift_rule',v_rule.id,jsonb_build_object('userId',p_user_id,'outletId',p_outlet_id,'effectiveFrom',p_effective_from,'weekdays',p_weekdays,'startsAt',p_starts_at,'endsAt',p_ends_at));
  return to_jsonb(v_rule);
end $$;
revoke all on function public.save_employee_shift_rule_v2(uuid,uuid,uuid,uuid,uuid,date,smallint[],time,time,text) from public,anon,authenticated;
grant execute on function public.save_employee_shift_rule_v2(uuid,uuid,uuid,uuid,uuid,date,smallint[],time,time,text) to service_role;

commit;
