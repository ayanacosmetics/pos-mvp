-- Build the POS catalog in Postgres and return its final JSON shape. The edge
-- Worker can forward this payload without parsing thousands of products and
-- price rules in JavaScript.

create or replace function public.load_pos_catalog_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_location_id uuid,
  p_outlet_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_products jsonb;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true) then
    raise exception 'Akun katalog tidak aktif';
  end if;
  if p_location_id is not null and not exists(select 1 from public.stock_locations where tenant_id=p_tenant_id and id=p_location_id and active=true) then
    raise exception 'Lokasi katalog tidak valid';
  end if;
  if p_outlet_id is not null and not exists(select 1 from public.outlets where tenant_id=p_tenant_id and id=p_outlet_id and active=true) then
    raise exception 'Outlet katalog tidak valid';
  end if;

  with unit_rows as (
    select unit.product_id,jsonb_agg(jsonb_build_object(
      'id',unit.id,'name',unit.name,'factor',unit.factor_to_base,'barcode',unit.barcode
    ) order by unit.factor_to_base,unit.name) units
    from public.product_units unit where unit.tenant_id=p_tenant_id group by unit.product_id
  ), rule_source as (
    select rule.product_id,rule.id,rule.customer_group_id,rule.min_base_qty,rule.unit_price_base,rule.priority
    from public.price_rules rule where rule.tenant_id=p_tenant_id
    union all
    select override.product_id,override.id,override.customer_group_id,override.min_base_qty,override.unit_price_base,100000
    from public.outlet_price_overrides override
    where override.tenant_id=p_tenant_id and override.outlet_id=p_outlet_id and override.active=true
  ), rule_rows as (
    select product_id,jsonb_agg(jsonb_build_object(
      'id',id,'customerGroupId',customer_group_id,'minBaseQty',min_base_qty,
      'unitPriceBase',unit_price_base,'priority',priority
    )) price_rules from rule_source group by product_id
  ), balance_rows as (
    select balance.product_id,sum(balance.quantity) quantity
    from public.stock_balances balance
    where balance.tenant_id=p_tenant_id and balance.location_id=p_location_id
    group by balance.product_id
  ), barcode_rows as (
    select barcode.family_id,jsonb_agg(barcode.barcode order by barcode.barcode) barcodes
    from public.product_family_barcodes barcode where barcode.tenant_id=p_tenant_id group by barcode.family_id
  ), option_rows as (
    select option.product_id,jsonb_agg(jsonb_build_object(
      'name',option.option_name,'value',option.option_value,'position',option.position
    ) order by option.position,option.option_name) options
    from public.product_variant_options option where option.tenant_id=p_tenant_id group by option.product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',product.id,'sku',product.sku,'name',product.name,'category',product.category,
    'brand',product.brand,'imageUrl',product.image_url,'active',product.active,
    'legacyCode',product.legacy_code,'variantGroup',product.variant_group,'variantName',product.variant_name,
    'minimumStock',coalesce(product.minimum_stock,0),'trackExpiry',coalesce(product.track_expiry,false),
    'trackStock',coalesce(product.track_stock,true),'familyId',product.family_id,'familyCode',family.code,
    'familyName',coalesce(family.name,product.variant_group),'familyBarcodes',coalesce(barcodes.barcodes,'[]'::jsonb),
    'variantOptions',coalesce(options.options,'[]'::jsonb),'stockBase',coalesce(balance.quantity,0),
    'units',coalesce(units.units,'[]'::jsonb),'priceRules',coalesce(rules.price_rules,'[]'::jsonb)
  ) order by product.name),'[]'::jsonb) into v_products
  from public.products product
  left join public.product_families family on family.tenant_id=p_tenant_id and family.id=product.family_id and family.active=true
  left join unit_rows units on units.product_id=product.id
  left join rule_rows rules on rules.product_id=product.id
  left join balance_rows balance on balance.product_id=product.id
  left join barcode_rows barcodes on barcodes.family_id=product.family_id
  left join option_rows options on options.product_id=product.id
  where product.tenant_id=p_tenant_id and product.active=true;

  return jsonb_build_object('products',v_products);
end $$;

revoke all on function public.load_pos_catalog_v1(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.load_pos_catalog_v1(uuid,uuid,uuid,uuid) to service_role;
