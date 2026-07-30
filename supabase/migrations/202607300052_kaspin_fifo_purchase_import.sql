-- Import historical Kasir Pintar purchases while preserving the already imported stock quantity.
begin;

alter table public.import_jobs drop constraint if exists import_jobs_import_kind_check;
alter table public.import_jobs add constraint import_jobs_import_kind_check
  check(import_kind in('PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES','KASPIN_FIFO','CUSTOMERS','SUPPLIERS'));

create or replace function public.import_kaspin_fifo_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_file_name text,
  p_location_id uuid,
  p_rows jsonb,
  p_capital_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_job public.import_jobs%rowtype;
  v_row jsonb;
  v_receipt_row record;
  v_product_id uuid;
  v_receipt_id uuid;
  v_opening_id uuid;
  v_tx text;
  v_document_no text;
  v_qty numeric;
  v_stock_qty numeric;
  v_old_avg numeric;
  v_remaining numeric;
  v_desired numeric;
  v_linked_cost numeric;
  v_modal numeric;
  v_legacy_cost numeric;
  v_old_available numeric;
  v_batch record;
  v_receipts integer:=0;
  v_items integer:=0;
  v_products integer:=0;
  v_layers integer:=0;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then
    raise exception 'Data pembelian Kaspin kosong';
  end if;
  if jsonb_typeof(p_capital_rows)<>'array' then
    raise exception 'Data laporan modal Kaspin tidak valid';
  end if;
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor riwayat FIFO'; end if;
  if not exists(
    select 1 from public.stock_locations where tenant_id=p_tenant_id and id=p_location_id
  ) then raise exception 'Lokasi stok tidak valid'; end if;

  select * into v_job from public.import_jobs
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);
  end if;

  -- One historical receipt per Kasir Pintar transaction. Re-importing an overlapping
  -- date range is safe because KASPIN document numbers are unique and existing ones are skipped.
  for v_receipt_row in
    select transaction_code,min(occurred_at) occurred_at,min(supplier_name) supplier_name
    from (
      select trim(value->>'transactionCode') transaction_code,
        (value->>'occurredAt')::timestamptz occurred_at,
        coalesce(nullif(trim(value->>'supplierName'),''),'Supplier Kaspin') supplier_name
      from jsonb_array_elements(p_rows)
    ) source
    group by transaction_code
  loop
    v_tx:=v_receipt_row.transaction_code;
    v_document_no:='KASPIN-'||v_tx;
    select id into v_receipt_id from public.purchase_receipts
    where tenant_id=p_tenant_id and document_no=v_document_no;
    if v_receipt_id is null then
      insert into public.purchase_receipts(
        tenant_id,supplier_id,supplier_name,location_id,document_no,idempotency_key,actor_id,status,occurred_at
      ) values(
        p_tenant_id,null,v_receipt_row.supplier_name,p_location_id,v_document_no,
        p_idempotency_key||':receipt:'||md5(v_tx),p_actor_id,'RECEIVED',v_receipt_row.occurred_at
      ) returning id into v_receipt_id;
      v_receipts:=v_receipts+1;
    end if;
  end loop;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_tx:=trim(v_row->>'transactionCode');
    v_document_no:='KASPIN-'||v_tx;
    select id into v_receipt_id from public.purchase_receipts
    where tenant_id=p_tenant_id and document_no=v_document_no
      and idempotency_key=p_idempotency_key||':receipt:'||md5(v_tx);
    if v_receipt_id is null then continue; end if;
    v_product_id:=(v_row->>'productId')::uuid;
    if not exists(select 1 from public.products where tenant_id=p_tenant_id and id=v_product_id) then
      raise exception 'Produk pembelian Kaspin tidak valid';
    end if;
    v_qty:=(v_row->>'quantity')::numeric;
    insert into public.purchase_receipt_items(
      tenant_id,receipt_id,product_id,base_qty,unit_cost,batch_no,expires_on,
      supplier_id,supplier_name,document_no,received_at
    ) values(
      p_tenant_id,v_receipt_id,v_product_id,v_qty,(v_row->>'unitCost')::numeric,
      'KASPIN-'||v_tx,null,null,coalesce(nullif(trim(v_row->>'supplierName'),''),'Supplier Kaspin'),
      v_document_no,(v_row->>'occurredAt')::timestamptz
    );
    v_items:=v_items+1;
  end loop;

  -- Rebuild only available cost layers. The stock balance quantity is never changed.
  for v_product_id in
    select distinct product_id from (
      select (value->>'productId')::uuid product_id from jsonb_array_elements(p_rows)
      union all
      select (value->>'productId')::uuid product_id from jsonb_array_elements(p_capital_rows)
    ) affected
  loop
    select quantity,avg_cost into v_stock_qty,v_old_avg
    from public.stock_balances
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product_id
    for update;
    if not found then continue; end if;
    v_products:=v_products+1;
    v_remaining:=greatest(v_stock_qty,0);
    v_linked_cost:=0;

    -- Newest receipts remain in stock; older receipts are considered consumed (FIFO).
    for v_batch in
      select id,received_qty,available_qty,unit_cost
      from public.inventory_batches
      where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product_id
        and receipt_id is not null
      order by received_at desc,id desc
    loop
      v_desired:=least(v_remaining,v_batch.received_qty);
      if v_desired<>v_batch.available_qty then
        insert into public.inventory_batch_movements(
          tenant_id,batch_id,delta,balance_after,event_type,reference_id,occurred_at
        ) values(
          p_tenant_id,v_batch.id,v_desired-v_batch.available_qty,v_desired,
          'KASPIN_FIFO_RECONCILE',null,now()
        );
        update public.inventory_batches set available_qty=v_desired where id=v_batch.id;
      end if;
      if v_desired>0 then
        v_layers:=v_layers+1;
        v_linked_cost:=v_linked_cost+(v_desired*v_batch.unit_cost);
        v_remaining:=v_remaining-v_desired;
      end if;
    end loop;

    select (value->>'remainingCapital')::numeric into v_modal
    from jsonb_array_elements(p_capital_rows)
    where (value->>'productId')::uuid=v_product_id
    limit 1;
    v_legacy_cost:=case
      when v_remaining>0 and v_modal is not null and v_modal>=v_linked_cost
        then round((v_modal-v_linked_cost)/v_remaining,4)
      else greatest(coalesce(v_old_avg,0),0)
    end;

    v_opening_id:=null;
    select id into v_opening_id from public.inventory_batches
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product_id
      and receipt_id is null
    order by case when batch_no like 'SALDO-AWAL%' then 0 else 1 end,received_at,id
    limit 1;

    for v_batch in
      select id,available_qty from public.inventory_batches
      where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product_id
        and receipt_id is null and (v_opening_id is null or id<>v_opening_id)
    loop
      if v_batch.available_qty<>0 then
        insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,occurred_at)
        values(p_tenant_id,v_batch.id,-v_batch.available_qty,0,'KASPIN_FIFO_RECONCILE',now());
        update public.inventory_batches set available_qty=0 where id=v_batch.id;
      end if;
    end loop;

    if v_remaining>0 then
      if v_opening_id is null then
        insert into public.inventory_batches(
          tenant_id,location_id,product_id,batch_no,received_qty,available_qty,unit_cost,received_at
        ) values(
          p_tenant_id,p_location_id,v_product_id,'SALDO-AWAL-KASPIN',v_remaining,v_remaining,v_legacy_cost,
          coalesce((select min((value->>'occurredAt')::timestamptz) from jsonb_array_elements(p_rows)),now())-interval '1 second'
        ) returning id into v_opening_id;
        insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,occurred_at)
        values(p_tenant_id,v_opening_id,v_remaining,v_remaining,'KASPIN_FIFO_RECONCILE',now());
      else
        select available_qty into v_old_available from public.inventory_batches where id=v_opening_id;
        update public.inventory_batches
        set received_qty=greatest(received_qty,v_remaining),available_qty=v_remaining,unit_cost=v_legacy_cost
        where id=v_opening_id;
        if v_old_available<>v_remaining then
          insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,occurred_at)
          values(p_tenant_id,v_opening_id,v_remaining-v_old_available,v_remaining,'KASPIN_FIFO_RECONCILE',now());
        end if;
      end if;
      v_layers:=v_layers+1;
    elsif v_opening_id is not null then
      select available_qty into v_old_available from public.inventory_batches where id=v_opening_id;
      if v_old_available<>0 then
        update public.inventory_batches set available_qty=0 where id=v_opening_id;
        insert into public.inventory_batch_movements(tenant_id,batch_id,delta,balance_after,event_type,occurred_at)
        values(p_tenant_id,v_opening_id,-v_old_available,0,'KASPIN_FIFO_RECONCILE',now());
      end if;
    end if;

    update public.stock_balances set
      avg_cost=case when v_stock_qty<=0 then 0 else round((v_linked_cost+(v_remaining*v_legacy_cost))/v_stock_qty,4) end,
      version=version+1,updated_at=now()
    where tenant_id=p_tenant_id and location_id=p_location_id and product_id=v_product_id;
  end loop;

  insert into public.import_jobs(
    tenant_id,actor_id,idempotency_key,import_kind,file_name,location_id,total_rows,
    created_rows,updated_rows,summary_json
  ) values(
    p_tenant_id,p_actor_id,p_idempotency_key,'KASPIN_FIFO',nullif(p_file_name,''),p_location_id,
    jsonb_array_length(p_rows),v_receipts,v_products,
    jsonb_build_object('kind','KASPIN_FIFO','total',jsonb_array_length(p_rows),'created',v_receipts,
      'updated',v_products,'receipts',v_receipts,'items',v_items,'layers',v_layers)
  ) returning * into v_job;
  update public.import_jobs set summary_json=summary_json||jsonb_build_object('id',v_job.id) where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'KASPIN_FIFO_IMPORTED','import_job',v_job.id,
    jsonb_build_object('fileName',p_file_name,'receipts',v_receipts,'items',v_items,'products',v_products,'stockQuantityChanged',false));

  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end
$$;

revoke all on function public.import_kaspin_fifo_v1(uuid,uuid,text,text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.import_kaspin_fifo_v1(uuid,uuid,text,text,uuid,jsonb,jsonb) to service_role;

commit;
