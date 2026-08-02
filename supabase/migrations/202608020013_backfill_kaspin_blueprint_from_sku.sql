-- Hotfix: older Kaspin imports have a stable KP-* source SKU but may not have legacy_code.
-- Backfill the already-mapped catalog without touching operational stock or transactions.

begin;

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

revoke all on function public.sync_catalog_variant_blueprint_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sync_catalog_variant_blueprint_v1(uuid,uuid) to service_role;

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

commit;
