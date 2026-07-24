-- Kasir Nusa POS - held carts, split payments, cash tender/change and printable receipt foundation

alter table public.payments add column if not exists tendered_amount numeric(19,4);
alter table public.payments add column if not exists change_amount numeric(19,4) not null default 0;

create table if not exists public.parked_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id),
  cashier_id uuid not null references public.profiles(user_id),
  label text not null,
  customer_id uuid references public.customers(id),
  customer_group_id text not null default 'retail',
  cart_json jsonb not null,
  quote_json jsonb not null,
  status text not null default 'HELD' check(status in ('HELD','RESUMED','CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resumed_at timestamptz
);

alter table public.parked_sales enable row level security;
drop policy if exists tenant_isolation on public.parked_sales;
create policy tenant_isolation on public.parked_sales for select to authenticated
  using(tenant_id=public.current_tenant_id());
grant select on public.parked_sales to authenticated;
grant select,insert,update on public.parked_sales to service_role;
create index if not exists parked_sales_open_idx on public.parked_sales(tenant_id,outlet_id,status,created_at desc);

create or replace function public.complete_sale_v2(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_outlet_id uuid,
  p_shift_id uuid,
  p_customer_id uuid,
  p_customer_group_id text,
  p_payments jsonb,
  p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid;
  v_existing public.sales%rowtype;
  v_location uuid;
  v_line jsonb;
  v_payment jsonb;
  v_balance public.stock_balances%rowtype;
  v_cost numeric:=0;
  v_line_cost numeric;
  v_seq bigint;
  v_receipt text;
  v_due numeric:=(p_quote->>'grandTotal')::numeric;
  v_paid numeric:=0;
  v_tendered numeric;
  v_amount numeric;
  v_change numeric:=0;
  v_method text;
  v_payment_count integer:=0;
  v_payment_label text;
  v_line_index integer:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true,'change',0);
  end if;
  if not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN') then
    raise exception 'Shift kasir belum dibuka';
  end if;
  if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'Pembayaran wajib diisi'; end if;
  if jsonb_array_length(p_payments)>4 then raise exception 'Maksimal empat metode pembayaran'; end if;

  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method'));
    v_amount:=coalesce((v_payment->>'amount')::numeric,0);
    if v_method not in ('CASH','QRIS','TRANSFER','EDC') then raise exception 'Metode pembayaran % tidak valid',v_method; end if;
    if v_amount<=0 then raise exception 'Jumlah pembayaran harus lebih dari nol'; end if;
    v_paid:=v_paid+v_amount;
    v_payment_count:=v_payment_count+1;
    if v_method='CASH' then
      v_tendered:=coalesce((v_payment->>'tendered')::numeric,v_amount);
      if v_tendered<v_amount then raise exception 'Uang tunai diterima kurang dari bagian tunai'; end if;
      v_change:=v_change+(v_tendered-v_amount);
    end if;
  end loop;
  if abs(v_paid-v_due)>0.01 then raise exception 'Total pembayaran % tidak sama dengan total transaksi %',v_paid,v_due; end if;

  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' limit 1;
  if v_location is null then raise exception 'Lokasi stok toko tidak ditemukan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:='UTM-'||lpad(v_seq::text,6,'0');
  if v_payment_count>1 then v_payment_label:='Gabungan';
  else
    v_payment_label:=case upper(p_payments->0->>'method') when 'CASH' then 'Tunai' when 'QRIS' then 'QRIS' when 'TRANSFER' then 'Transfer' else 'EDC' end;
  end if;
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,
    (p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,v_due,0,v_payment_label) returning id into v_sale;

  for v_line in select value from jsonb_array_elements(p_quote->'lines') loop
    v_line_index:=v_line_index+1;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=(v_line->>'productId')::uuid for update;
    if not found or v_balance.quantity<(v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName'; end if;
    v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric;v_cost:=v_cost+v_line_cost;
    update public.stock_balances set quantity=quantity-(v_line->>'baseQty')::numeric,version=version+1,updated_at=now()
      where location_id=v_location and product_id=(v_line->>'productId')::uuid;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key)
    values(p_tenant_id,v_location,(v_line->>'productId')::uuid,-(v_line->>'baseQty')::numeric,v_balance.quantity-(v_line->>'baseQty')::numeric,
      v_balance.avg_cost,'SALE',v_sale,p_actor_id,p_idempotency_key||':stock:'||v_line_index);
    insert into public.sale_items(tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,pricing_snapshot,promotion_snapshot)
    values(p_tenant_id,v_sale,(v_line->>'productId')::uuid,v_line->>'productName',(v_line->>'baseQty')::numeric,(v_line->>'gross')::numeric,
      (v_line->>'discount')::numeric,(v_line->>'total')::numeric,v_line_cost,
      jsonb_build_object('priceRuleId',v_line->>'priceRuleId','unitName',v_line->>'unitName','qty',v_line->>'qty'),coalesce(v_line->'promotions','[]'));
  end loop;
  update public.sales set cost_total=v_cost where id=v_sale;

  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method'));v_amount:=(v_payment->>'amount')::numeric;
    v_tendered:=case when v_method='CASH' then coalesce((v_payment->>'tendered')::numeric,v_amount) else null end;
    insert into public.payments(tenant_id,sale_id,method,amount,reference,tendered_amount,change_amount)
    values(p_tenant_id,v_sale,v_method,v_amount,nullif(trim(v_payment->>'reference'),''),v_tendered,
      case when v_method='CASH' then v_tendered-v_amount else 0 end);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,
    jsonb_build_object('receiptNo',v_receipt,'grandTotal',v_due,'paymentCount',v_payment_count,'change',v_change));
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false,'change',v_change,'payments',p_payments);
end $$;

revoke all on function public.complete_sale_v2(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_sale_v2(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) to service_role;
