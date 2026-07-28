-- Kasir Nusa POS - safe Excel product import, stable automatic SKU, and non-destructive mass edit

create table if not exists public.product_sku_sequences (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  next_number bigint not null default 1 check(next_number>0),
  updated_at timestamptz not null default now()
);
create table if not exists public.product_import_sku_reservations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  idempotency_key text not null,
  row_index integer not null check(row_index>0),
  sku text not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,idempotency_key,row_index),
  unique(tenant_id,sku)
);
alter table public.product_sku_sequences enable row level security;
alter table public.product_import_sku_reservations enable row level security;
grant select,insert,update on public.product_sku_sequences to service_role;
grant select,insert,update on public.product_import_sku_reservations to service_role;

create or replace function public.allocate_product_skus_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_count integer
) returns text[] language plpgsql security definer set search_path=public as $$
declare v_next bigint;v_max bigint;v_index integer;v_candidate text;v_result text[]:=array[]::text[];
begin
  if p_count<0 or p_count>10000 then raise exception 'Jumlah SKU otomatis tidak valid';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Akses ditolak';end if;
  select array_agg(sku order by row_index) into v_result from public.product_import_sku_reservations where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if coalesce(array_length(v_result,1),0)=p_count then return coalesce(v_result,array[]::text[]);end if;
  if coalesce(array_length(v_result,1),0)>0 then raise exception 'Reservasi SKU otomatis tidak lengkap';end if;
  insert into public.product_sku_sequences(tenant_id,next_number) values(p_tenant_id,1) on conflict(tenant_id) do nothing;
  select next_number into v_next from public.product_sku_sequences where tenant_id=p_tenant_id for update;
  select coalesce(max((regexp_match(sku,'^[0-9]+$'))[1]::bigint),0) into v_max from public.products where tenant_id=p_tenant_id and sku~'^[0-9]+$';
  v_next:=greatest(v_next,v_max+1);v_result:=array[]::text[];
  for v_index in 1..p_count loop
    loop
      v_candidate:=lpad(v_next::text,6,'0');v_next:=v_next+1;
      exit when not exists(select 1 from public.products where tenant_id=p_tenant_id and sku=v_candidate)
        and not exists(select 1 from public.product_import_sku_reservations where tenant_id=p_tenant_id and sku=v_candidate);
    end loop;
    insert into public.product_import_sku_reservations(tenant_id,idempotency_key,row_index,sku) values(p_tenant_id,p_idempotency_key,v_index,v_candidate);
    v_result:=array_append(v_result,v_candidate);
  end loop;
  update public.product_sku_sequences set next_number=v_next,updated_at=now() where tenant_id=p_tenant_id;
  return v_result;
end $$;

create or replace function public.update_import_products_v1(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_file_name text,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_job public.import_jobs%rowtype;v_row jsonb;v_product uuid;v_unit uuid;v_code text;v_barcode text;v_bulk_barcode text;v_updated integer:=0;v_affected integer;
begin
  select * into v_job from public.import_jobs where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 or jsonb_array_length(p_rows)>500 then raise exception 'Data edit barang harus 1 sampai 500 baris';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Akses ditolak';end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_code:=upper(trim(v_row->>'sku'));v_barcode:=nullif(trim(v_row->>'baseBarcode'),'');v_bulk_barcode:=nullif(trim(v_row->>'bulkBarcode'),'');
    select id into v_product from public.products where tenant_id=p_tenant_id and sku=v_code;
    if v_product is null then raise exception 'SKU % tidak ditemukan untuk diedit',v_code;end if;
    if v_barcode is not null and exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode and product_id<>v_product) then raise exception 'Barcode % sudah dipakai produk lain',v_barcode;end if;
    if v_bulk_barcode is not null and exists(select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_bulk_barcode and product_id<>v_product) then raise exception 'Barcode % sudah dipakai produk lain',v_bulk_barcode;end if;
    update public.products set name=trim(v_row->>'name'),category=coalesce(nullif(trim(v_row->>'category'),''),'Lainnya'),brand=nullif(trim(v_row->>'brand'),''),minimum_stock=coalesce((v_row->>'minimumStock')::numeric,0),track_expiry=coalesce((v_row->>'trackExpiry')::boolean,false),active=true,updated_at=now() where id=v_product;
    select id into v_unit from public.product_units where product_id=v_product and factor_to_base=1 order by id limit 1;
    if v_unit is null then insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode) values(p_tenant_id,v_product,coalesce(nullif(trim(v_row->>'baseUnit'),''),'pcs'),1,v_barcode);
    else update public.product_units set name=coalesce(nullif(trim(v_row->>'baseUnit'),''),'pcs'),barcode=v_barcode where id=v_unit;end if;
    if coalesce((v_row->>'bulkFactor')::numeric,0)>1 and nullif(trim(v_row->>'bulkUnit'),'') is not null then
      select id into v_unit from public.product_units where product_id=v_product and factor_to_base>1 order by factor_to_base limit 1;
      if v_unit is null then insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode) values(p_tenant_id,v_product,trim(v_row->>'bulkUnit'),(v_row->>'bulkFactor')::numeric,v_bulk_barcode);
      else update public.product_units set name=trim(v_row->>'bulkUnit'),factor_to_base=(v_row->>'bulkFactor')::numeric,barcode=v_bulk_barcode where id=v_unit;end if;
    end if;
    update public.price_rules set unit_price_base=(v_row->>'retailPrice')::numeric,priority=10 where tenant_id=p_tenant_id and product_id=v_product and customer_group_id='retail' and min_base_qty=1 and starts_at is null and ends_at is null;
    get diagnostics v_affected=row_count;
    if v_affected=0 then insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority) values(p_tenant_id,v_product,'retail',1,(v_row->>'retailPrice')::numeric,10);end if;
    v_updated:=v_updated+1;
  end loop;
  insert into public.import_jobs(tenant_id,actor_id,idempotency_key,import_kind,file_name,total_rows,created_rows,updated_rows,summary_json)
  values(p_tenant_id,p_actor_id,p_idempotency_key,'PRODUCTS',nullif(p_file_name,''),jsonb_array_length(p_rows),0,v_updated,jsonb_build_object('kind','PRODUCTS','total',jsonb_array_length(p_rows),'created',0,'updated',v_updated)) returning * into v_job;
  update public.import_jobs set summary_json=summary_json||jsonb_build_object('id',v_job.id) where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,'PRODUCTS_MASS_UPDATED','import_job',v_job.id,jsonb_build_object('fileName',p_file_name,'updated',v_updated));
  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end $$;

create or replace function public.apply_import_product_settings_v1(p_tenant_id uuid,p_actor_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Akses ditolak';end if;
  update public.products p set minimum_stock=coalesce((r.value->>'minimumStock')::numeric,0),track_expiry=coalesce((r.value->>'trackExpiry')::boolean,false),updated_at=now()
  from jsonb_array_elements(p_rows) r where p.tenant_id=p_tenant_id and p.sku=upper(trim(r.value->>'sku'));
  get diagnostics v_count=row_count;return v_count;
end $$;

revoke all on function public.allocate_product_skus_v1(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.update_import_products_v1(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.apply_import_product_settings_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.allocate_product_skus_v1(uuid,uuid,text,integer) to service_role;
grant execute on function public.update_import_products_v1(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.apply_import_product_settings_v1(uuid,uuid,jsonb) to service_role;
