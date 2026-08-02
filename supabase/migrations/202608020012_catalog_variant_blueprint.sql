-- Preserve Kaspin product-family decisions across destructive migration resets.
-- Operational product UUIDs may be recreated; blueprint identity never depends on them.

begin;

create table if not exists public.catalog_family_blueprints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_system text not null default 'KASPIN',
  family_code text not null,
  family_name text not null,
  shared_barcodes jsonb not null default '[]'::jsonb check(jsonb_typeof(shared_barcodes)='array'),
  version integer not null default 1 check(version>0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,source_system,family_code)
);

create table if not exists public.catalog_variant_blueprints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_system text not null default 'KASPIN',
  source_key text not null,
  source_legacy_code text,
  source_name_snapshot text not null,
  family_code text not null,
  variant_name text not null,
  option_values jsonb not null default '[]'::jsonb check(jsonb_typeof(option_values)='array'),
  version integer not null default 1 check(version>0),
  active boolean not null default true,
  last_match_status text not null default 'SAVED' check(last_match_status in('SAVED','MATCHED','UNMATCHED','AMBIGUOUS')),
  last_product_id uuid,
  last_matched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,source_system,source_key)
);

create index if not exists catalog_variant_blueprints_family_idx
  on public.catalog_variant_blueprints(tenant_id,source_system,family_code) where active;
create index if not exists catalog_variant_blueprints_legacy_idx
  on public.catalog_variant_blueprints(tenant_id,source_system,source_legacy_code) where active and source_legacy_code is not null;

alter table public.catalog_family_blueprints enable row level security;
alter table public.catalog_variant_blueprints enable row level security;
grant select,insert,update,delete on public.catalog_family_blueprints to service_role;
grant select,insert,update,delete on public.catalog_variant_blueprints to service_role;

create or replace function public.sync_catalog_variant_blueprint_v1(
  p_tenant_id uuid,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_families integer:=0;v_variants integer:=0;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN')) then
    raise exception 'Hanya Owner atau Admin yang dapat menyimpan Blueprint varian';
  end if;

  insert into public.catalog_family_blueprints(
    tenant_id,source_system,family_code,family_name,shared_barcodes,active
  )
  select distinct on(f.id)
    p_tenant_id,'KASPIN',f.code,f.name,
    coalesce((select jsonb_agg(b.barcode order by b.barcode) from public.product_family_barcodes b where b.family_id=f.id),'[]'::jsonb),true
  from public.product_families f
  join public.products p on p.tenant_id=f.tenant_id and p.family_id=f.id
  where f.tenant_id=p_tenant_id
    and (nullif(trim(p.legacy_code),'') is not null or upper(p.sku) like 'KP-%')
  order by f.id
  on conflict(tenant_id,source_system,family_code) do update set
    family_name=excluded.family_name,shared_barcodes=excluded.shared_barcodes,
    version=catalog_family_blueprints.version+1,active=true,updated_at=now();
  get diagnostics v_families=row_count;

  insert into public.catalog_variant_blueprints(
    tenant_id,source_system,source_key,source_legacy_code,source_name_snapshot,
    family_code,variant_name,option_values,active,last_match_status,last_product_id,last_matched_at
  )
  select p_tenant_id,'KASPIN',upper(p.sku),nullif(trim(p.legacy_code),''),p.name,
    f.code,coalesce(nullif(trim(p.variant_name),''),p.name),
    coalesce((select jsonb_agg(jsonb_build_object('name',o.option_name,'value',o.option_value,'position',o.position) order by o.position,o.option_name)
      from public.product_variant_options o where o.product_id=p.id),'[]'::jsonb),
    true,'MATCHED',p.id,now()
  from public.products p join public.product_families f on f.id=p.family_id and f.tenant_id=p.tenant_id
  where p.tenant_id=p_tenant_id
    and (nullif(trim(p.legacy_code),'') is not null or upper(p.sku) like 'KP-%')
  on conflict(tenant_id,source_system,source_key) do update set
    source_legacy_code=excluded.source_legacy_code,source_name_snapshot=excluded.source_name_snapshot,
    family_code=excluded.family_code,variant_name=excluded.variant_name,option_values=excluded.option_values,
    version=catalog_variant_blueprints.version+1,active=true,last_match_status='MATCHED',
    last_product_id=excluded.last_product_id,last_matched_at=now(),updated_at=now();
  get diagnostics v_variants=row_count;

  return jsonb_build_object('saved',true,'families',v_families,'variants',v_variants);
end $$;

create or replace function public.apply_catalog_variant_blueprint_v1(
  p_tenant_id uuid,p_actor_id uuid,p_source_system text default 'KASPIN'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_family record;v_blueprint record;v_option jsonb;v_barcode jsonb;
  v_family_id uuid;v_product_id uuid;v_legacy_matches integer;v_affected integer;
  v_family_created integer:=0;v_matched integer:=0;v_unmatched integer:=0;v_ambiguous integer:=0;
  v_options integer:=0;v_barcodes integer:=0;v_barcode_skipped integer:=0;
begin
  p_source_system:=upper(coalesce(nullif(trim(p_source_system),''),'KASPIN'));
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN')) then
    raise exception 'Hanya Owner atau Admin yang dapat menerapkan Blueprint varian';
  end if;

  for v_family in
    select f.* from public.catalog_family_blueprints f
    where f.tenant_id=p_tenant_id and f.source_system=p_source_system and f.active
      and exists(select 1 from public.catalog_variant_blueprints b where b.tenant_id=f.tenant_id and b.source_system=f.source_system and b.family_code=f.family_code and b.active)
    order by f.created_at,f.family_code
  loop
    v_family_id:=null;
    select id into v_family_id from public.product_families where tenant_id=p_tenant_id and code=v_family.family_code limit 1;
    if v_family_id is null then
      select id into v_family_id from public.product_families where tenant_id=p_tenant_id and lower(name)=lower(v_family.family_name) limit 1;
    end if;
    if v_family_id is null then
      insert into public.product_families(tenant_id,code,name,active)
      values(p_tenant_id,v_family.family_code,v_family.family_name,true) returning id into v_family_id;
      v_family_created:=v_family_created+1;
    else
      update public.product_families set name=v_family.family_name,active=true,updated_at=now() where id=v_family_id;
    end if;

    for v_barcode in select value from jsonb_array_elements(coalesce(v_family.shared_barcodes,'[]'::jsonb)) loop
      if exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=trim(both '"' from v_barcode::text)) then
        v_barcode_skipped:=v_barcode_skipped+1;
      else
        insert into public.product_family_barcodes(tenant_id,family_id,barcode)
        values(p_tenant_id,v_family_id,trim(both '"' from v_barcode::text)) on conflict do nothing;
        get diagnostics v_affected=row_count;v_barcodes:=v_barcodes+v_affected;
      end if;
    end loop;
  end loop;

  for v_blueprint in
    select b.*,f.family_name from public.catalog_variant_blueprints b
    join public.catalog_family_blueprints f on f.tenant_id=b.tenant_id and f.source_system=b.source_system and f.family_code=b.family_code and f.active
    where b.tenant_id=p_tenant_id and b.source_system=p_source_system and b.active
    order by b.created_at,b.source_key
  loop
    v_product_id:=null;v_legacy_matches:=0;
    select id into v_product_id from public.products where tenant_id=p_tenant_id and upper(sku)=upper(v_blueprint.source_key) limit 1;
    if v_product_id is null and nullif(trim(v_blueprint.source_legacy_code),'') is not null then
      select count(*) into v_legacy_matches from public.products where tenant_id=p_tenant_id and legacy_code=v_blueprint.source_legacy_code;
      if v_legacy_matches=1 then
        select id into v_product_id from public.products where tenant_id=p_tenant_id and legacy_code=v_blueprint.source_legacy_code limit 1;
      elsif v_legacy_matches>1 then
        v_ambiguous:=v_ambiguous+1;
        update public.catalog_variant_blueprints set last_match_status='AMBIGUOUS',last_product_id=null,updated_at=now() where id=v_blueprint.id;
        continue;
      end if;
    end if;
    if v_product_id is null then
      v_unmatched:=v_unmatched+1;
      update public.catalog_variant_blueprints set last_match_status='UNMATCHED',last_product_id=null,updated_at=now() where id=v_blueprint.id;
      continue;
    end if;

    v_family_id:=null;
    select id into v_family_id from public.product_families where tenant_id=p_tenant_id and(code=v_blueprint.family_code or lower(name)=lower(v_blueprint.family_name)) order by(case when code=v_blueprint.family_code then 0 else 1 end) limit 1;
    if v_family_id is null then raise exception 'Etalase Blueprint % belum dapat dibuat',v_blueprint.family_code;end if;
    update public.products set family_id=v_family_id,variant_group=v_blueprint.family_name,
      variant_name=v_blueprint.variant_name,updated_at=now() where id=v_product_id;
    update public.catalog_variant_blueprints set last_match_status='MATCHED',last_product_id=v_product_id,last_matched_at=now(),updated_at=now() where id=v_blueprint.id;
    v_matched:=v_matched+1;

    for v_option in select value from jsonb_array_elements(coalesce(v_blueprint.option_values,'[]'::jsonb)) loop
      update public.product_variant_options set option_name=trim(v_option->>'name'),option_value=trim(v_option->>'value'),
        position=coalesce((v_option->>'position')::smallint,1),updated_at=now()
      where product_id=v_product_id and lower(option_name)=lower(trim(v_option->>'name'));
      get diagnostics v_affected=row_count;
      if v_affected=0 then
        insert into public.product_variant_options(tenant_id,product_id,option_name,option_value,position)
        values(p_tenant_id,v_product_id,trim(v_option->>'name'),trim(v_option->>'value'),coalesce((v_option->>'position')::smallint,1));
      end if;
      v_options:=v_options+1;
    end loop;
  end loop;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,details_json)
  values(p_tenant_id,p_actor_id,'CATALOG_VARIANT_BLUEPRINT_APPLIED','catalog_blueprint',
    jsonb_build_object('sourceSystem',p_source_system,'matched',v_matched,'unmatched',v_unmatched,'ambiguous',v_ambiguous,'familiesCreated',v_family_created));
  return jsonb_build_object('applied',true,'familiesCreated',v_family_created,'matched',v_matched,
    'unmatched',v_unmatched,'ambiguous',v_ambiguous,'optionsRestored',v_options,
    'sharedBarcodesRestored',v_barcodes,'sharedBarcodesSkipped',v_barcode_skipped);
end $$;

revoke all on function public.sync_catalog_variant_blueprint_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.apply_catalog_variant_blueprint_v1(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sync_catalog_variant_blueprint_v1(uuid,uuid) to service_role;
grant execute on function public.apply_catalog_variant_blueprint_v1(uuid,uuid,text) to service_role;

-- Snapshot all Kaspin mappings that already exist when this migration is installed.
insert into public.catalog_family_blueprints(tenant_id,source_system,family_code,family_name,shared_barcodes)
select distinct on(f.tenant_id,f.code) f.tenant_id,'KASPIN',f.code,f.name,
  coalesce((select jsonb_agg(b.barcode order by b.barcode) from public.product_family_barcodes b where b.family_id=f.id),'[]'::jsonb)
from public.product_families f join public.products p on p.tenant_id=f.tenant_id and p.family_id=f.id
where nullif(trim(p.legacy_code),'') is not null or upper(p.sku) like 'KP-%'
order by f.tenant_id,f.code,f.created_at
on conflict(tenant_id,source_system,family_code) do update set
  family_name=excluded.family_name,shared_barcodes=excluded.shared_barcodes,active=true,updated_at=now();

insert into public.catalog_variant_blueprints(
  tenant_id,source_system,source_key,source_legacy_code,source_name_snapshot,family_code,variant_name,option_values,last_match_status,last_product_id,last_matched_at
)
select p.tenant_id,'KASPIN',upper(p.sku),nullif(trim(p.legacy_code),''),p.name,f.code,
  coalesce(nullif(trim(p.variant_name),''),p.name),
  coalesce((select jsonb_agg(jsonb_build_object('name',o.option_name,'value',o.option_value,'position',o.position) order by o.position,o.option_name)
    from public.product_variant_options o where o.product_id=p.id),'[]'::jsonb),
  'MATCHED',p.id,now()
from public.products p join public.product_families f on f.id=p.family_id and f.tenant_id=p.tenant_id
where nullif(trim(p.legacy_code),'') is not null or upper(p.sku) like 'KP-%'
on conflict(tenant_id,source_system,source_key) do update set
  source_legacy_code=excluded.source_legacy_code,source_name_snapshot=excluded.source_name_snapshot,
  family_code=excluded.family_code,variant_name=excluded.variant_name,option_values=excluded.option_values,
  active=true,last_match_status='MATCHED',last_product_id=excluded.last_product_id,last_matched_at=now(),updated_at=now();

-- Reset operational catalog data, but snapshot and retain its independent Blueprint.
create or replace function public.reset_tenant_data_v2(p_tenant_id uuid,p_actor_id uuid,p_scopes text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;v_blueprint jsonb:=jsonb_build_object('saved',true,'families',0,'variants',0);
  v_scopes text[]:=array(select distinct upper(value) from unnest(coalesce(p_scopes,'{}')) value);
  v_catalog boolean;
begin
  v_catalog:='ALL'=any(v_scopes) or 'CATALOG'=any(v_scopes);
  if v_catalog then v_blueprint:=public.sync_catalog_variant_blueprint_v1(p_tenant_id,p_actor_id);end if;
  v_result:=public.reset_tenant_data_v1(p_tenant_id,p_actor_id,p_scopes);
  if v_catalog then
    delete from public.product_family_barcodes where tenant_id=p_tenant_id;
    delete from public.product_families where tenant_id=p_tenant_id;
  end if;
  return v_result||jsonb_build_object('catalogFamiliesReset',v_catalog,'variantBlueprintPreserved',true,'variantBlueprint',v_blueprint);
end $$;
revoke all on function public.reset_tenant_data_v2(uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.reset_tenant_data_v2(uuid,uuid,text[]) to service_role;

commit;
