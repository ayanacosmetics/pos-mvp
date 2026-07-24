-- Kasir Nusa POS - complete product master editing, units, variants and safe archival

alter table public.products add column if not exists variant_group text;
alter table public.products add column if not exists variant_name text;
alter table public.products add column if not exists minimum_stock numeric(19,6) not null default 0 check(minimum_stock>=0);
alter table public.products add column if not exists track_expiry boolean not null default false;

create index if not exists products_variant_group_idx
  on public.products(tenant_id,variant_group) where variant_group is not null;

create or replace function public.save_product_v2(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_product jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_product uuid;
  v_existing public.products%rowtype;
  v_created boolean:=false;
  v_sku text:=upper(trim(p_product->>'sku'));
  v_name text:=trim(p_product->>'name');
  v_unit jsonb;
  v_unit_id uuid;
  v_keep_units uuid[]:='{}'::uuid[];
  v_names text[]:='{}'::text[];
  v_barcodes text[]:='{}'::text[];
  v_factor numeric;
  v_unit_name text;
  v_barcode text;
  v_base_count integer:=0;
begin
  if not exists(
    select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id
      and active=true and role in ('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengelola produk'; end if;
  if v_sku='' or v_name='' then raise exception 'SKU dan nama produk wajib diisi'; end if;
  if coalesce((p_product->>'retailPrice')::numeric,0)<=0 then raise exception 'Harga ecer harus lebih dari nol'; end if;
  if jsonb_typeof(p_product->'units')<>'array' or jsonb_array_length(p_product->'units')=0 then
    raise exception 'Produk harus memiliki minimal satu satuan';
  end if;

  if nullif(p_product->>'id','') is not null then
    select * into v_existing from public.products
      where id=(p_product->>'id')::uuid and tenant_id=p_tenant_id for update;
    if not found then raise exception 'Produk tidak ditemukan'; end if;
    v_product:=v_existing.id;
  end if;
  if exists(select 1 from public.products where tenant_id=p_tenant_id and sku=v_sku and id is distinct from v_product) then
    raise exception 'SKU % sudah digunakan',v_sku;
  end if;

  if v_product is null then
    insert into public.products(
      tenant_id,sku,name,category,brand,variant_group,variant_name,minimum_stock,track_expiry,active
    ) values(
      p_tenant_id,v_sku,v_name,coalesce(nullif(trim(p_product->>'category'),''),'Lainnya'),
      nullif(trim(p_product->>'brand'),''),nullif(trim(p_product->>'variantGroup'),''),
      nullif(trim(p_product->>'variantName'),''),coalesce((p_product->>'minimumStock')::numeric,0),
      coalesce((p_product->>'trackExpiry')::boolean,false),true
    ) returning id into v_product;
    v_created:=true;
  else
    update public.products set
      sku=v_sku,name=v_name,category=coalesce(nullif(trim(p_product->>'category'),''),'Lainnya'),
      brand=nullif(trim(p_product->>'brand'),''),variant_group=nullif(trim(p_product->>'variantGroup'),''),
      variant_name=nullif(trim(p_product->>'variantName'),''),minimum_stock=coalesce((p_product->>'minimumStock')::numeric,0),
      track_expiry=coalesce((p_product->>'trackExpiry')::boolean,false),updated_at=now()
    where id=v_product;
    update public.product_units set name='__editing__'||id::text,barcode=null where product_id=v_product;
  end if;

  for v_unit in select value from jsonb_array_elements(p_product->'units') loop
    v_unit_name:=trim(v_unit->>'name');
    v_factor:=(v_unit->>'factor')::numeric;
    v_barcode:=nullif(trim(v_unit->>'barcode'),'');
    if v_unit_name='' or v_factor<=0 then raise exception 'Nama dan isi satuan tidak valid'; end if;
    if lower(v_unit_name)=any(v_names) then raise exception 'Nama satuan % tercatat dua kali',v_unit_name; end if;
    v_names:=array_append(v_names,lower(v_unit_name));
    if v_barcode is not null then
      if v_barcode=any(v_barcodes) then raise exception 'Barcode % tercatat dua kali',v_barcode; end if;
      if exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode and product_id<>v_product) then
        raise exception 'Barcode % sudah digunakan produk lain',v_barcode;
      end if;
      v_barcodes:=array_append(v_barcodes,v_barcode);
    end if;
    if v_factor=1 then v_base_count:=v_base_count+1; end if;

    v_unit_id:=null;
    if nullif(v_unit->>'id','') is not null then
      select id into v_unit_id from public.product_units
        where id=(v_unit->>'id')::uuid and product_id=v_product;
    end if;
    if v_unit_id is null then
      insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode)
      values(p_tenant_id,v_product,v_unit_name,v_factor,v_barcode) returning id into v_unit_id;
    else
      update public.product_units set name=v_unit_name,factor_to_base=v_factor,barcode=v_barcode where id=v_unit_id;
    end if;
    v_keep_units:=array_append(v_keep_units,v_unit_id);
  end loop;
  if v_base_count<>1 then raise exception 'Harus ada tepat satu satuan dasar dengan isi 1'; end if;
  delete from public.product_units where product_id=v_product and not(id=any(v_keep_units));

  delete from public.price_rules where tenant_id=p_tenant_id and product_id=v_product and starts_at is null and ends_at is null;
  insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
  values(p_tenant_id,v_product,'retail',1,(p_product->>'retailPrice')::numeric,10);
  if coalesce((p_product->>'wholesalePrice')::numeric,0)>0 then
    insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
    values(p_tenant_id,v_product,'wholesale',1,(p_product->>'wholesalePrice')::numeric,20);
  end if;
  if coalesce((p_product->>'tierQty')::numeric,0)>1 and coalesce((p_product->>'tierPrice')::numeric,0)>0 then
    insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
    values(p_tenant_id,v_product,null,(p_product->>'tierQty')::numeric,(p_product->>'tierPrice')::numeric,30);
  end if;

  insert into public.stock_balances(tenant_id,location_id,product_id)
  select p_tenant_id,id,v_product from public.stock_locations where tenant_id=p_tenant_id
  on conflict(location_id,product_id) do nothing;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when v_created then 'PRODUCT_CREATED' else 'PRODUCT_UPDATED' end,'product',v_product,
    jsonb_build_object('sku',v_sku,'name',v_name,'unitCount',jsonb_array_length(p_product->'units')));
  return jsonb_build_object('id',v_product,'sku',v_sku,'name',v_name,'created',v_created);
end $$;

create or replace function public.set_product_active(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_product_id uuid,
  p_active boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_product public.products%rowtype;
begin
  if not exists(
    select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id
      and active=true and role in ('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengubah status produk'; end if;
  select * into v_product from public.products where tenant_id=p_tenant_id and id=p_product_id for update;
  if not found then raise exception 'Produk tidak ditemukan'; end if;
  if not p_active and exists(
    select 1 from public.purchase_order_items item join public.purchase_orders orders on orders.id=item.order_id
    where item.product_id=p_product_id and orders.status in ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED')
  ) then raise exception 'Produk masih digunakan pada Purchase Order yang belum selesai'; end if;
  update public.products set active=p_active,updated_at=now() where id=p_product_id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when p_active then 'PRODUCT_RESTORED' else 'PRODUCT_ARCHIVED' end,'product',p_product_id,
    jsonb_build_object('sku',v_product.sku,'active',p_active));
  return jsonb_build_object('id',p_product_id,'sku',v_product.sku,'active',p_active);
end $$;

revoke all on function public.save_product_v2(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.set_product_active(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.save_product_v2(uuid,uuid,jsonb) to service_role;
grant execute on function public.set_product_active(uuid,uuid,uuid,boolean) to service_role;
