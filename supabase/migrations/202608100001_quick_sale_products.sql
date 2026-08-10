-- Allow POS staff to register a minimal, auditable product during checkout.
-- Quick products are permanent non-stock catalog rows under "Perlu dilengkapi";
-- catalog managers can complete their master data later through the normal editor.

begin;

create or replace function public.create_quick_sale_product_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_name text,
  p_retail_price numeric,
  p_barcode text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_name text:=left(trim(coalesce(p_name,'')),160);
  v_barcode text:=nullif(left(trim(coalesce(p_barcode,'')),80),'');
  v_sku text;
  v_product_id uuid;
  v_unit_id uuid;
begin
  if not public.profile_has_permission_v1(p_tenant_id,p_actor_id,'pos.sell') then
    raise exception 'Akun tidak memiliki izin transaksi kasir';
  end if;
  if length(v_name)<2 then raise exception 'Nama barang minimal 2 karakter'; end if;
  if coalesce(p_retail_price,0)<=0 or p_retail_price>1000000000000 then
    raise exception 'Harga jual barang tidak valid';
  end if;
  if v_barcode is not null and exists(
    select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode
  ) then raise exception 'Barcode sudah digunakan barang lain'; end if;

  loop
    v_sku:='CEPAT-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
    exit when not exists(select 1 from public.products where tenant_id=p_tenant_id and sku=v_sku);
  end loop;

  insert into public.products(
    tenant_id,sku,name,category,brand,minimum_stock,track_expiry,track_stock,active
  ) values(
    p_tenant_id,v_sku,v_name,'Perlu dilengkapi',null,0,false,false,true
  ) returning id into v_product_id;

  insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode)
  values(p_tenant_id,v_product_id,'pcs',1,v_barcode)
  returning id into v_unit_id;

  insert into public.price_rules(
    tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority
  ) values(p_tenant_id,v_product_id,'retail',1,p_retail_price,10);

  insert into public.stock_balances(tenant_id,location_id,product_id)
  select p_tenant_id,id,v_product_id
  from public.stock_locations where tenant_id=p_tenant_id
  on conflict(location_id,product_id) do nothing;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'QUICK_PRODUCT_CREATED','product',v_product_id,
    jsonb_build_object('sku',v_sku,'name',v_name,'retailPrice',p_retail_price,
      'barcode',v_barcode,'needsReview',true,'trackStock',false));

  return jsonb_build_object(
    'id',v_product_id,'unitId',v_unit_id,'sku',v_sku,'name',v_name,
    'category','Perlu dilengkapi','retailPrice',p_retail_price,
    'barcode',v_barcode,'trackStock',false,'needsReview',true
  );
end $$;

revoke all on function public.create_quick_sale_product_v1(uuid,uuid,text,numeric,text)
  from public,anon,authenticated;
grant execute on function public.create_quick_sale_product_v1(uuid,uuid,text,numeric,text)
  to service_role;

commit;
