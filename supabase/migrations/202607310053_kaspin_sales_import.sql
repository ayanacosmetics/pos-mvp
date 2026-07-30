-- Import Kasir Pintar historical receipts without changing the already imported ending stock.
begin;

alter table public.import_jobs drop constraint if exists import_jobs_import_kind_check;
alter table public.import_jobs add constraint import_jobs_import_kind_check
  check(import_kind in('PRODUCTS','PRODUCT_UNITS','PRODUCT_VARIANTS','PRODUCT_PRICES','KASPIN_FIFO','KASPIN_SALES','CUSTOMERS','SUPPLIERS'));

alter table public.sales add column if not exists source_system text not null default 'NUSA';
alter table public.sales add column if not exists external_reference text;
alter table public.sales add column if not exists source_cashier text;
alter table public.sales add column if not exists source_payload jsonb not null default '{}';

create unique index if not exists sales_external_reference_key
  on public.sales(tenant_id,source_system,external_reference)
  where external_reference is not null;

create or replace function public.import_kaspin_sales_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_file_name text,
  p_outlet_id uuid,
  p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_job public.import_jobs%rowtype;
  v_receipt record;
  v_line jsonb;
  v_sale_id uuid;
  v_shift_id uuid;
  v_product_id uuid;
  v_transaction_code text;
  v_occurred_at timestamptz;
  v_subtotal numeric;
  v_grand_total numeric;
  v_discount_total numeric;
  v_cost_total numeric;
  v_line_gross numeric;
  v_line_discount numeric;
  v_line_total numeric;
  v_payment_method text;
  v_tendered numeric;
  v_change numeric;
  v_receipts integer:=0;
  v_items integer:=0;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then
    raise exception 'Data penjualan Kaspin kosong';
  end if;
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin yang dapat mengimpor riwayat penjualan'; end if;
  if not exists(
    select 1 from public.outlets where tenant_id=p_tenant_id and id=p_outlet_id and active=true
  ) then raise exception 'Outlet tujuan tidak valid'; end if;

  select * into v_job from public.import_jobs
  where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',true);
  end if;

  for v_receipt in
    select
      trim(value->>'transactionCode') transaction_code,
      min((value->>'occurredAt')::timestamptz) occurred_at,
      max((value->>'grandTotal')::numeric) grand_total,
      max(coalesce((value->>'tendered')::numeric,(value->>'grandTotal')::numeric)) tendered,
      max(coalesce((value->>'change')::numeric,0)) change_amount,
      min(coalesce(nullif(trim(value->>'paymentMethod'),''),'Cash')) payment_method,
      min(nullif(trim(value->>'cashier'),'')) source_cashier,
      min(nullif(trim(value->>'customerName'),'')) customer_name,
      min(nullif(trim(value->>'customerEmail'),'')) customer_email,
      min(nullif(trim(value->>'note'),'')) note,
      sum((value->>'lineGross')::numeric) subtotal,
      sum((value->>'quantity')::numeric*(value->>'unitCost')::numeric) cost_total
    from jsonb_array_elements(p_rows)
    group by trim(value->>'transactionCode')
  loop
    v_transaction_code:=v_receipt.transaction_code;
    if exists(
      select 1 from public.sales
      where tenant_id=p_tenant_id and source_system='KASPIN' and external_reference=v_transaction_code
    ) then continue; end if;

    v_occurred_at:=v_receipt.occurred_at;
    v_subtotal:=greatest(coalesce(v_receipt.subtotal,0),0);
    v_grand_total:=greatest(coalesce(v_receipt.grand_total,v_subtotal),0);
    v_discount_total:=greatest(v_subtotal-v_grand_total,0);
    v_cost_total:=greatest(coalesce(v_receipt.cost_total,0),0);
    v_payment_method:=coalesce(nullif(trim(v_receipt.payment_method),''),'Cash');
    v_tendered:=greatest(coalesce(v_receipt.tendered,v_grand_total),v_grand_total);
    v_change:=greatest(coalesce(v_receipt.change_amount,v_tendered-v_grand_total),0);

    if v_shift_id is null then
      insert into public.shifts(
        tenant_id,outlet_id,cashier_id,opened_at,closed_at,opening_cash,
        expected_cash,closing_cash,difference,status
      ) values(
        p_tenant_id,p_outlet_id,p_actor_id,v_occurred_at,v_occurred_at,0,0,0,0,'CLOSED'
      ) returning id into v_shift_id;
    else
      update public.shifts
      set opened_at=least(opened_at,v_occurred_at),closed_at=greatest(closed_at,v_occurred_at)
      where id=v_shift_id;
    end if;

    insert into public.sales(
      tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,
      customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method,
      status,occurred_at,notes,source_system,external_reference,source_cashier,source_payload
    ) values(
      p_tenant_id,p_outlet_id,v_shift_id,null,'KASPIN-'||v_transaction_code,
      p_idempotency_key||':sale:'||md5(v_transaction_code),p_actor_id,'retail',
      v_subtotal,v_discount_total,v_grand_total,v_cost_total,v_payment_method,
      'COMPLETED',v_occurred_at,
      coalesce(v_receipt.note,'Impor riwayat Kasir Pintar'),
      'KASPIN',v_transaction_code,v_receipt.source_cashier,
      jsonb_build_object('customerName',v_receipt.customer_name,'customerEmail',v_receipt.customer_email)
    ) returning id into v_sale_id;

    for v_line in
      select value from jsonb_array_elements(p_rows)
      where trim(value->>'transactionCode')=v_transaction_code
    loop
      v_product_id:=(v_line->>'productId')::uuid;
      if not exists(
        select 1 from public.products where tenant_id=p_tenant_id and id=v_product_id
      ) then raise exception 'Produk pada struk Kaspin tidak valid'; end if;
      v_line_gross:=greatest((v_line->>'lineGross')::numeric,0);
      v_line_discount:=case when v_subtotal>0
        then round(v_discount_total*v_line_gross/v_subtotal,4) else 0 end;
      v_line_total:=greatest(v_line_gross-v_line_discount,0);
      insert into public.sale_items(
        tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,
        pricing_snapshot,promotion_snapshot
      ) values(
        p_tenant_id,v_sale_id,v_product_id,coalesce(nullif(trim(v_line->>'productName'),''),'Produk'),
        (v_line->>'quantity')::numeric,v_line_gross,v_line_discount,v_line_total,
        round((v_line->>'quantity')::numeric*(v_line->>'unitCost')::numeric,4),
        jsonb_build_object(
          'qty',(v_line->>'quantity')::numeric,'unitName','pcs','baseQty',(v_line->>'quantity')::numeric,
          'unitPriceBase',(v_line->>'unitPrice')::numeric,'source','KASPIN',
          'externalProductCode',v_line->>'productCode'
        ),'[]'::jsonb
      );
      v_items:=v_items+1;
    end loop;

    insert into public.payments(
      tenant_id,sale_id,method,amount,reference,tendered_amount,change_amount
    ) values(
      p_tenant_id,v_sale_id,v_payment_method,v_grand_total,'KASPIN-'||v_transaction_code,
      v_tendered,v_change
    );
    v_receipts:=v_receipts+1;
  end loop;

  insert into public.import_jobs(
    tenant_id,actor_id,idempotency_key,import_kind,file_name,location_id,total_rows,
    created_rows,updated_rows,summary_json
  ) values(
    p_tenant_id,p_actor_id,p_idempotency_key,'KASPIN_SALES',nullif(p_file_name,''),null,
    jsonb_array_length(p_rows),v_receipts,0,
    jsonb_build_object('kind','KASPIN_SALES','total',jsonb_array_length(p_rows),
      'created',v_receipts,'updated',0,'receipts',v_receipts,'items',v_items,'stockQuantityChanged',false)
  ) returning * into v_job;
  update public.import_jobs
  set summary_json=summary_json||jsonb_build_object('id',v_job.id)
  where id=v_job.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(
    p_tenant_id,p_actor_id,'KASPIN_SALES_IMPORTED','import_job',v_job.id,
    jsonb_build_object('fileName',p_file_name,'receipts',v_receipts,'items',v_items,'stockQuantityChanged',false)
  );
  return v_job.summary_json||jsonb_build_object('id',v_job.id,'duplicate',false);
end
$$;

revoke all on function public.import_kaspin_sales_v1(uuid,uuid,text,text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.import_kaspin_sales_v1(uuid,uuid,text,text,uuid,jsonb)
  to service_role;

commit;
