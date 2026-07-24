-- Kasir Nusa POS - controlled initial master data and opening stock import

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.profiles(user_id),
  idempotency_key text not null,
  import_kind text not null check(import_kind in ('PRODUCTS','CUSTOMERS','SUPPLIERS')),
  file_name text,
  location_id uuid references public.stock_locations(id),
  total_rows integer not null default 0,
  created_rows integer not null default 0,
  updated_rows integer not null default 0,
  status text not null default 'COMPLETED' check(status in ('COMPLETED','FAILED')),
  summary_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

alter table public.import_jobs enable row level security;
drop policy if exists tenant_isolation on public.import_jobs;
create policy tenant_isolation on public.import_jobs for select to authenticated
  using(tenant_id=public.current_tenant_id());
grant select on public.import_jobs to authenticated;
grant select,insert,update on public.import_jobs to service_role;
create index if not exists import_jobs_recent_idx on public.import_jobs(tenant_id,created_at desc);

create or replace function public.import_initial_data(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_kind text,
  p_file_name text,
  p_location_id uuid,
  p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_job public.import_jobs%rowtype;
  v_row jsonb;
  v_index bigint;
  v_created integer:=0;
  v_updated integer:=0;
  v_product uuid;
  v_unit uuid;
  v_code text;
  v_name text;
  v_barcode text;
  v_bulk_barcode text;
  v_qty numeric;
  v_cost numeric;
  v_balance public.stock_balances%rowtype;
  v_batch uuid;
begin
  p_kind:=upper(coalesce(p_kind,''));
  if p_kind not in ('PRODUCTS','CUSTOMERS','SUPPLIERS') then raise exception 'Jenis impor tidak valid'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then raise exception 'Data impor kosong'; end if;
  if jsonb_array_length(p_rows)>500 then raise exception 'Maksimal 500 baris per proses impor'; end if;
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in ('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor data'; end if;

  select * into v_job from public.import_jobs
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);
  end if;

  if p_kind='PRODUCTS' then
    if p_location_id is not null and not exists(
      select 1 from public.stock_locations where id=p_location_id and tenant_id=p_tenant_id
    ) then raise exception 'Lokasi stok awal tidak valid'; end if;

    for v_row,v_index in
      select value,ordinality from jsonb_array_elements(p_rows) with ordinality
    loop
      v_code:=upper(trim(v_row->>'sku'));
      v_name:=trim(v_row->>'name');
      v_barcode:=nullif(trim(v_row->>'baseBarcode'),'');
      v_bulk_barcode:=nullif(trim(v_row->>'bulkBarcode'),'');

      select id into v_product from public.products where tenant_id=p_tenant_id and sku=v_code;
      if v_product is null then
        insert into public.products(tenant_id,sku,name,category,brand)
        values(p_tenant_id,v_code,v_name,coalesce(nullif(trim(v_row->>'category'),''),'Lainnya'),nullif(trim(v_row->>'brand'),''))
        returning id into v_product;
        v_created:=v_created+1;
      else
        update public.products set
          name=v_name,
          category=coalesce(nullif(trim(v_row->>'category'),''),'Lainnya'),
          brand=nullif(trim(v_row->>'brand'),''),
          active=true,
          updated_at=now()
        where id=v_product;
        v_updated:=v_updated+1;
      end if;

      if v_barcode is not null and exists(
        select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_barcode and product_id<>v_product
      ) then raise exception 'Barcode % pada baris % sudah dipakai produk lain',v_barcode,v_index; end if;
      if v_bulk_barcode is not null and exists(
        select 1 from public.product_units where tenant_id=p_tenant_id and barcode=v_bulk_barcode and product_id<>v_product
      ) then raise exception 'Barcode grosir % pada baris % sudah dipakai produk lain',v_bulk_barcode,v_index; end if;

      select id into v_unit from public.product_units
      where product_id=v_product and factor_to_base=1 order by id limit 1;
      if v_unit is null then
        insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode)
        values(p_tenant_id,v_product,coalesce(nullif(trim(v_row->>'baseUnit'),''),'pcs'),1,v_barcode)
        returning id into v_unit;
      else
        update public.product_units set
          name=coalesce(nullif(trim(v_row->>'baseUnit'),''),'pcs'),barcode=v_barcode
        where id=v_unit;
      end if;

      if coalesce((v_row->>'bulkFactor')::numeric,0)>1 and nullif(trim(v_row->>'bulkUnit'),'') is not null then
        select id into v_unit from public.product_units
        where product_id=v_product and lower(name)=lower(trim(v_row->>'bulkUnit')) limit 1;
        if v_unit is null then
          insert into public.product_units(tenant_id,product_id,name,factor_to_base,barcode)
          values(p_tenant_id,v_product,trim(v_row->>'bulkUnit'),(v_row->>'bulkFactor')::numeric,v_bulk_barcode);
        else
          update public.product_units set factor_to_base=(v_row->>'bulkFactor')::numeric,barcode=v_bulk_barcode where id=v_unit;
        end if;
      end if;

      delete from public.price_rules
      where tenant_id=p_tenant_id and product_id=v_product and starts_at is null and ends_at is null;
      insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
      values(p_tenant_id,v_product,'retail',1,(v_row->>'retailPrice')::numeric,10);
      if coalesce((v_row->>'wholesalePrice')::numeric,0)>0 then
        insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
        values(p_tenant_id,v_product,'wholesale',1,(v_row->>'wholesalePrice')::numeric,20);
      end if;
      if coalesce((v_row->>'tierQty')::numeric,0)>1 and coalesce((v_row->>'tierPrice')::numeric,0)>0 then
        insert into public.price_rules(tenant_id,product_id,customer_group_id,min_base_qty,unit_price_base,priority)
        values(p_tenant_id,v_product,null,(v_row->>'tierQty')::numeric,(v_row->>'tierPrice')::numeric,30);
      end if;

      insert into public.stock_balances(tenant_id,location_id,product_id)
      select p_tenant_id,id,v_product from public.stock_locations where tenant_id=p_tenant_id
      on conflict(location_id,product_id) do nothing;

      if v_row ? 'openingQty' and nullif(v_row->>'openingQty','') is not null then
        if p_location_id is null then raise exception 'Lokasi stok awal wajib dipilih'; end if;
        if exists(
          select 1 from public.stock_ledger
          where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product
        ) then raise exception 'Stok awal % tidak dapat diimpor karena produk sudah memiliki riwayat transaksi',v_code; end if;
        v_qty:=(v_row->>'openingQty')::numeric;
        v_cost:=coalesce((v_row->>'openingCost')::numeric,0);
        select * into v_balance from public.stock_balances
        where location_id=p_location_id and product_id=v_product for update;
        update public.stock_balances set quantity=v_qty,avg_cost=case when v_qty=0 then 0 else v_cost end,
          version=version+1,updated_at=now()
        where location_id=p_location_id and product_id=v_product;
        if v_qty>0 then
          insert into public.stock_ledger(
            tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key
          ) values(
            p_tenant_id,p_location_id,v_product,v_qty,v_qty,v_cost,'OPENING_IMPORT',
            gen_random_uuid(),'Impor saldo awal '||coalesce(p_file_name,''),p_actor_id,p_idempotency_key||':stock:'||v_index
          );
          insert into public.inventory_batches(
            tenant_id,location_id,product_id,batch_no,expires_on,received_qty,available_qty,unit_cost,received_at
          ) values(
            p_tenant_id,p_location_id,v_product,coalesce(nullif(trim(v_row->>'batchNo'),''),'SALDO-AWAL'),
            nullif(v_row->>'expiresOn','')::date,v_qty,v_qty,v_cost,now()
          ) returning id into v_batch;
          insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,occurred_at)
          values(p_tenant_id,v_batch,v_qty,v_qty,'OPENING_IMPORT',now());
        end if;
      end if;
    end loop;
  elsif p_kind='CUSTOMERS' then
    for v_row,v_index in select value,ordinality from jsonb_array_elements(p_rows) with ordinality loop
      v_code:=upper(trim(v_row->>'code')); v_name:=trim(v_row->>'name');
      if exists(select 1 from public.customers where tenant_id=p_tenant_id and code=v_code) then
        update public.customers set name=v_name,phone=nullif(trim(v_row->>'phone'),''),
          group_id=case when lower(v_row->>'groupId')='wholesale' then 'wholesale' else 'retail' end,active=true
        where tenant_id=p_tenant_id and code=v_code;
        v_updated:=v_updated+1;
      else
        insert into public.customers(tenant_id,code,name,phone,group_id)
        values(p_tenant_id,v_code,v_name,nullif(trim(v_row->>'phone'),''),
          case when lower(v_row->>'groupId')='wholesale' then 'wholesale' else 'retail' end);
        v_created:=v_created+1;
      end if;
    end loop;
  else
    for v_row,v_index in select value,ordinality from jsonb_array_elements(p_rows) with ordinality loop
      v_code:=upper(trim(v_row->>'code')); v_name:=trim(v_row->>'name');
      if exists(select 1 from public.suppliers where tenant_id=p_tenant_id and code=v_code) then
        update public.suppliers set name=v_name,phone=nullif(trim(v_row->>'phone'),''),
          address=nullif(trim(v_row->>'address'),''),active=true
        where tenant_id=p_tenant_id and code=v_code;
        v_updated:=v_updated+1;
      else
        insert into public.suppliers(tenant_id,code,name,phone,address)
        values(p_tenant_id,v_code,v_name,nullif(trim(v_row->>'phone'),''),nullif(trim(v_row->>'address'),''));
        v_created:=v_created+1;
      end if;
    end loop;
  end if;

  insert into public.import_jobs(
    tenant_id,actor_id,idempotency_key,import_kind,file_name,location_id,total_rows,created_rows,updated_rows,summary_json
  ) values(
    p_tenant_id,p_actor_id,p_idempotency_key,p_kind,nullif(p_file_name,''),p_location_id,
    jsonb_array_length(p_rows),v_created,v_updated,
    jsonb_build_object('kind',p_kind,'total',jsonb_array_length(p_rows),'created',v_created,'updated',v_updated)
  ) returning * into v_job;

  update public.import_jobs set summary_json=summary_json||jsonb_build_object('id',v_job.id) where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'INITIAL_DATA_IMPORTED','import_job',v_job.id,
    jsonb_build_object('kind',p_kind,'fileName',p_file_name,'total',jsonb_array_length(p_rows),'created',v_created,'updated',v_updated));

  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end $$;

revoke all on function public.import_initial_data(uuid,uuid,text,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_initial_data(uuid,uuid,text,text,text,uuid,jsonb) to service_role;
