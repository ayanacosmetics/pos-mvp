-- Kasir Nusa POS - separate imports for unlimited units, variants, and customer price tiers
begin;

alter table public.import_jobs drop constraint if exists import_jobs_import_kind_check;
alter table public.import_jobs add constraint import_jobs_import_kind_check
  check(import_kind in('PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES','CUSTOMERS','SUPPLIERS'));

create or replace function public.import_product_extensions_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_kind text,p_file_name text,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_job public.import_jobs%rowtype;v_row jsonb;v_product uuid;v_unit uuid;v_rule uuid;
  v_sku text;v_name text;v_barcode text;v_group text;v_factor numeric;v_min_qty numeric;v_price numeric;
  v_created integer:=0;v_updated integer:=0;v_existed boolean;
begin
  p_kind:=upper(coalesce(p_kind,''));
  if p_kind not in('PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES') then raise exception 'Jenis data produk tambahan tidak valid';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 or jsonb_array_length(p_rows)>500 then raise exception 'Data harus berisi 1 sampai 500 baris';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor data';end if;
  select * into v_job from public.import_jobs where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_sku:=upper(trim(v_row->>'sku'));
    select id into v_product from public.products where tenant_id=p_tenant_id and sku=v_sku for update;
    if v_product is null then raise exception 'SKU % belum ada. Import Barang utama terlebih dahulu',v_sku;end if;

    if p_kind='PRODUCT_UNITS' then
      v_name:=trim(v_row->>'unitName');v_factor:=(v_row->>'factor')::numeric;v_barcode:=nullif(trim(v_row->>'barcode'),'');
      if v_name='' or v_factor<=0 then raise exception 'Nama atau isi satuan SKU % tidak valid',v_sku;end if;
      if v_barcode is not null and exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode and product_id<>v_product) then raise exception 'Barcode % sudah dipakai produk lain',v_barcode;end if;
      v_unit:=null;
      if v_factor=1 then select id into v_unit from public.product_units where product_id=v_product and factor_to_base=1 order by id limit 1;
      else select id into v_unit from public.product_units where product_id=v_product and lower(name)=lower(v_name) limit 1;end if;
      if v_unit is null then
        insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode) values(p_tenant_id,v_product,v_name,v_factor,v_barcode);
        v_created:=v_created+1;
      else
        update public.product_units set name=v_name,factor_to_base=v_factor,barcode=v_barcode where id=v_unit;
        v_updated:=v_updated+1;
      end if;
    elsif p_kind='PRODUCT_VARIANTS' then
      update public.products set variant_group=nullif(trim(v_row->>'variantGroup'),''),variant_name=nullif(trim(v_row->>'variantName'),''),updated_at=now() where id=v_product;
      v_updated:=v_updated+1;
    else
      v_group:=trim(v_row->>'customerGroup');v_min_qty:=(v_row->>'minQty')::numeric;v_price:=(v_row->>'unitPrice')::numeric;
      if v_group='retail' then raise exception 'Harga Umum harus diubah melalui file Barang';end if;
      if v_min_qty<=0 or v_price<=0 then raise exception 'Tingkat harga SKU % tidak valid',v_sku;end if;
      if not exists(select 1 from public.customer_price_groups where tenant_id=p_tenant_id and id=v_group and active=true) then raise exception 'Tipe pelanggan % tidak aktif',v_group;end if;
      select exists(select 1 from public.price_rules where tenant_id=p_tenant_id and product_id=v_product and customer_group_id=v_group and min_base_qty=v_min_qty and starts_at is null and ends_at is null) into v_existed;
      delete from public.price_rules where tenant_id=p_tenant_id and product_id=v_product and customer_group_id=v_group and min_base_qty=v_min_qty and starts_at is null and ends_at is null;
      insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority,source,policy_tenant_id)
      values(p_tenant_id,v_product,v_group,v_min_qty,v_price,60,'MANUAL',null);
      if v_existed then v_updated:=v_updated+1;else v_created:=v_created+1;end if;
    end if;
  end loop;

  insert into public.import_jobs(tenant_id,actor_id,idempotency_key,import_kind,file_name,total_rows,created_rows,updated_rows,summary_json)
  values(p_tenant_id,p_actor_id,p_idempotency_key,p_kind,nullif(p_file_name,''),jsonb_array_length(p_rows),v_created,v_updated,
    jsonb_build_object('kind',p_kind,'total',jsonb_array_length(p_rows),'created',v_created,'updated',v_updated)) returning * into v_job;
  update public.import_jobs set summary_json=summary_json||jsonb_build_object('id',v_job.id) where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case p_kind when 'PRODUCT_UNITS' then 'PRODUCT_UNITS_MASS_UPDATED' when 'PRODUCT_VARIANTS' then 'PRODUCT_VARIANTS_MASS_UPDATED' else 'PRODUCT_PRICES_MASS_UPDATED' end,
    'import_job',v_job.id,jsonb_build_object('fileName',p_file_name,'created',v_created,'updated',v_updated));
  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end $$;

-- Harga manual hasil import menang atas tingkat otomatis yang sama.
create or replace function public.refresh_safe_customer_prices_v1(
  p_tenant_id uuid,p_product_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_policy public.safe_customer_price_policies%rowtype;v_product record;v_rule jsonb;
  v_retail numeric;v_cost numeric;v_price numeric;v_profit numeric;v_group text;
  v_min_qty integer;v_discount numeric;v_safe integer:=0;v_skipped integer:=0;v_products integer:=0;
begin
  select * into v_policy from public.safe_customer_price_policies where tenant_id=p_tenant_id and active=true;
  if not found then return jsonb_build_object('active',false,'products',0,'safeRules',0,'skippedRules',0);end if;
  for v_product in select id from public.products where tenant_id=p_tenant_id and active=true and(p_product_id is null or id=p_product_id)and(v_policy.category is null or category=v_policy.category)and(v_policy.brand is null or brand=v_policy.brand) loop
    select unit_price_base into v_retail from public.price_rules where tenant_id=p_tenant_id and product_id=v_product.id and customer_group_id='retail' and min_base_qty=1 and starts_at is null and ends_at is null order by case when source='MANUAL' then 0 else 1 end,priority desc limit 1;
    if v_retail is null then continue;end if;
    select coalesce(max(avg_cost),0) into v_cost from public.stock_balances where tenant_id=p_tenant_id and product_id=v_product.id;
    delete from public.price_rules where tenant_id=p_tenant_id and product_id=v_product.id and starts_at is null and ends_at is null and(source='AUTOMATIC' or policy_tenant_id=p_tenant_id);
    for v_rule in select value from jsonb_array_elements(v_policy.rules_json) loop
      v_group:=trim(v_rule->>'customerGroupId');v_min_qty:=(v_rule->>'minBaseQty')::integer;v_discount:=(v_rule->>'discountAmount')::numeric;
      if exists(select 1 from public.price_rules where tenant_id=p_tenant_id and product_id=v_product.id and customer_group_id=v_group and min_base_qty=v_min_qty and starts_at is null and ends_at is null and source='MANUAL') then v_skipped:=v_skipped+1;continue;end if;
      v_price:=v_retail-v_discount;v_profit:=v_price-v_cost;
      if v_cost>0 and v_price>0 and v_profit>=v_policy.min_profit then
        insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority,source,policy_tenant_id)
        values(p_tenant_id,v_product.id,v_group,v_min_qty,v_price,40,'AUTOMATIC',p_tenant_id);v_safe:=v_safe+1;
      else v_skipped:=v_skipped+1;end if;
    end loop;
    v_products:=v_products+1;
  end loop;
  return jsonb_build_object('active',true,'products',v_products,'safeRules',v_safe,'skippedRules',v_skipped);
end $$;

revoke all on function public.import_product_extensions_v1(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.import_product_extensions_v1(uuid,uuid,text,text,text,jsonb) to service_role;

commit;
