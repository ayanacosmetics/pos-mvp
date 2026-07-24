-- Kasir Nusa v1.14
-- Master pelanggan lengkap, penjualan kredit, jurnal piutang, dan pelunasan FIFO.

alter table public.customers add column if not exists email text;
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists notes text;
alter table public.customers add column if not exists credit_enabled boolean not null default false;
alter table public.customers add column if not exists credit_limit numeric(19,4) not null default 0;
alter table public.customers add column if not exists credit_days integer not null default 0;
alter table public.customers add column if not exists updated_at timestamptz not null default now();

alter table public.sales add column if not exists credit_amount numeric(19,4) not null default 0;
alter table public.sales add column if not exists paid_credit_amount numeric(19,4) not null default 0;
alter table public.sales add column if not exists due_on date;
alter table public.sales add column if not exists account_status text not null default 'PAID';

do $$ begin
  if not exists(select 1 from pg_constraint where conname='customers_credit_limit_nonnegative') then
    alter table public.customers add constraint customers_credit_limit_nonnegative check(credit_limit>=0) not valid;
  end if;
  if not exists(select 1 from pg_constraint where conname='customers_credit_days_range') then
    alter table public.customers add constraint customers_credit_days_range check(credit_days between 0 and 365) not valid;
  end if;
  if not exists(select 1 from pg_constraint where conname='sales_account_status_check') then
    alter table public.sales add constraint sales_account_status_check
      check(account_status in ('PAID','OPEN','PARTIAL','OVERDUE','VOID')) not valid;
  end if;
end $$;

create table if not exists public.customer_account_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  entry_type text not null check(entry_type in ('SALE_CREDIT','PAYMENT','RETURN_CREDIT','OPENING_BALANCE','ADJUSTMENT')),
  amount numeric(19,4) not null check(amount<>0),
  balance_after numeric(19,4) not null check(balance_after>=0),
  reference_type text not null,
  reference_id uuid,
  document_no text,
  due_on date,
  note text,
  actor_id uuid not null references public.profiles(user_id),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create table if not exists public.customer_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  outlet_id uuid not null references public.outlets(id),
  receipt_no text not null,
  idempotency_key text not null,
  amount numeric(19,4) not null check(amount>0),
  method text not null check(method in ('CASH','QRIS','TRANSFER','EDC')),
  reference text,
  shift_id uuid references public.shifts(id),
  actor_id uuid not null references public.profiles(user_id),
  occurred_at timestamptz not null default now(),
  unique(tenant_id,receipt_no),
  unique(tenant_id,idempotency_key)
);

create table if not exists public.customer_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  payment_receipt_id uuid not null references public.customer_payment_receipts(id) on delete cascade,
  sale_id uuid not null references public.sales(id),
  amount numeric(19,4) not null check(amount>0),
  created_at timestamptz not null default now(),
  unique(payment_receipt_id,sale_id)
);

create index if not exists customer_account_statement_idx on public.customer_account_entries(tenant_id,customer_id,occurred_at desc);
create index if not exists customer_credit_sales_idx on public.sales(tenant_id,customer_id,account_status,due_on) where credit_amount>0;
create index if not exists customer_payment_receipts_idx on public.customer_payment_receipts(tenant_id,customer_id,occurred_at desc);

alter table public.customer_account_entries enable row level security;
alter table public.customer_payment_receipts enable row level security;
alter table public.customer_payment_allocations enable row level security;

create or replace function public.save_customer_profile(
  p_tenant_id uuid,p_actor_id uuid,p_customer_id uuid,p_name text,p_phone text,p_email text,
  p_address text,p_group_id text,p_credit_enabled boolean,p_credit_limit numeric,
  p_credit_days integer,p_notes text,p_active boolean
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor public.profiles%rowtype; v_customer public.customers%rowtype; v_seq bigint;
  v_enable boolean:=coalesce(p_credit_enabled,false); v_limit numeric:=coalesce(p_credit_limit,0);
begin
  select * into v_actor from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true;
  if not found or v_actor.role not in ('OWNER','ADMIN','CASHIER') then raise exception 'Akun tidak dapat mengelola pelanggan'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nama pelanggan wajib diisi'; end if;
  if p_group_id not in ('retail','wholesale') then raise exception 'Kelompok pelanggan tidak valid'; end if;
  if v_limit<0 or coalesce(p_credit_days,0) not between 0 and 365 then raise exception 'Batas atau tempo kredit tidak valid'; end if;
  if v_actor.role='CASHIER' and (v_enable or v_limit>0) then raise exception 'Hanya Owner atau Admin yang dapat mengaktifkan kredit'; end if;
  if v_enable and v_limit<=0 then raise exception 'Batas kredit harus lebih dari nol'; end if;

  if p_customer_id is null then
    insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'CUSTOMER',2)
    on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1
    returning next_value-1 into v_seq;
    insert into public.customers(
      tenant_id,code,name,phone,email,address,group_id,credit_enabled,credit_limit,credit_days,notes,active
    ) values(
      p_tenant_id,'PLG-'||lpad(v_seq::text,5,'0'),trim(p_name),nullif(trim(p_phone),''),
      nullif(lower(trim(p_email)),''),nullif(trim(p_address),''),p_group_id,v_enable,v_limit,
      coalesce(p_credit_days,0),nullif(trim(p_notes),''),coalesce(p_active,true)
    ) returning * into v_customer;
  else
    if v_actor.role='CASHIER' then raise exception 'Hanya Owner atau Admin yang dapat mengubah profil pelanggan'; end if;
    update public.customers set
      name=trim(p_name),phone=nullif(trim(p_phone),''),email=nullif(lower(trim(p_email)),''),
      address=nullif(trim(p_address),''),group_id=p_group_id,credit_enabled=v_enable,
      credit_limit=v_limit,credit_days=coalesce(p_credit_days,0),notes=nullif(trim(p_notes),''),
      active=coalesce(p_active,true),updated_at=now()
    where id=p_customer_id and tenant_id=p_tenant_id returning * into v_customer;
    if not found then raise exception 'Pelanggan tidak ditemukan'; end if;
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,case when p_customer_id is null then 'CUSTOMER_CREATED' else 'CUSTOMER_UPDATED' end,
    'customer',v_customer.id,jsonb_build_object('code',v_customer.code,'groupId',v_customer.group_id,
    'creditEnabled',v_customer.credit_enabled,'creditLimit',v_customer.credit_limit,'creditDays',v_customer.credit_days));
  return to_jsonb(v_customer);
end $$;

-- complete_sale_v3 tetap menjadi mesin posting stok/pembayaran dasar.
-- Versi ini menambahkan CREDIT sebagai alokasi non-kas; validasi rekening dilakukan complete_sale_v5.
create or replace function public.complete_sale_v3(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_shift_id uuid,p_customer_id uuid,p_customer_group_id text,p_payments jsonb,p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid; v_existing public.sales%rowtype; v_location uuid; v_line jsonb; v_payment jsonb;
  v_balance public.stock_balances%rowtype; v_outlet public.outlets%rowtype; v_cost numeric:=0;
  v_line_cost numeric; v_seq bigint; v_receipt text; v_due numeric:=(p_quote->>'grandTotal')::numeric;
  v_paid numeric:=0; v_tendered numeric; v_amount numeric; v_change numeric:=0; v_method text;
  v_payment_count integer:=0; v_payment_label text; v_line_index integer:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true,'change',0); end if;
  select * into v_outlet from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true;
  if not found then raise exception 'Outlet transaksi tidak aktif'; end if;
  if not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN') then raise exception 'Shift kasir belum dibuka'; end if;
  if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'Pembayaran wajib diisi'; end if;
  if jsonb_array_length(p_payments)>4 then raise exception 'Maksimal empat metode pembayaran'; end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method')); v_amount:=coalesce((v_payment->>'amount')::numeric,0);
    if v_method not in ('CASH','QRIS','TRANSFER','EDC','CREDIT') then raise exception 'Metode pembayaran % tidak valid',v_method; end if;
    if v_amount<=0 then raise exception 'Jumlah pembayaran harus lebih dari nol'; end if;
    v_paid:=v_paid+v_amount; v_payment_count:=v_payment_count+1;
    if v_method='CASH' then
      v_tendered:=coalesce((v_payment->>'tendered')::numeric,v_amount);
      if v_tendered<v_amount then raise exception 'Uang tunai diterima kurang dari bagian tunai'; end if;
      v_change:=v_change+(v_tendered-v_amount);
    end if;
  end loop;
  if abs(v_paid-v_due)>0.01 then raise exception 'Total pembayaran % tidak sama dengan total transaksi %',v_paid,v_due; end if;
  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' and active=true order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko aktif tidak ditemukan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE:'||p_outlet_id::text,2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:=v_outlet.receipt_prefix||'-'||lpad(v_seq::text,6,'0');
  if v_payment_count>1 then v_payment_label:='Gabungan';
  else v_payment_label:=case upper(p_payments->0->>'method') when 'CASH' then 'Tunai' when 'QRIS' then 'QRIS' when 'TRANSFER' then 'Transfer' when 'CREDIT' then 'Piutang' else 'EDC' end; end if;
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,
    (p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,v_due,0,v_payment_label) returning id into v_sale;
  for v_line in select value from jsonb_array_elements(p_quote->'lines') loop
    v_line_index:=v_line_index+1;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=(v_line->>'productId')::uuid for update;
    if not found or v_balance.quantity<(v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName'; end if;
    v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric; v_cost:=v_cost+v_line_cost;
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
    v_method:=upper(trim(v_payment->>'method')); v_amount:=(v_payment->>'amount')::numeric;
    v_tendered:=case when v_method='CASH' then coalesce((v_payment->>'tendered')::numeric,v_amount) else null end;
    insert into public.payments(tenant_id,sale_id,method,amount,reference,tendered_amount,change_amount)
    values(p_tenant_id,v_sale,v_method,v_amount,nullif(trim(v_payment->>'reference'),''),v_tendered,
      case when v_method='CASH' then v_tendered-v_amount else 0 end);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,jsonb_build_object('receiptNo',v_receipt,'grandTotal',v_due,'paymentCount',v_payment_count,'change',v_change,'outletPrefix',v_outlet.receipt_prefix));
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false,'change',v_change,'payments',p_payments);
end $$;

create or replace function public.complete_sale_v5(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_shift_id uuid,p_customer_id uuid,p_customer_group_id text,p_payments jsonb,p_quote jsonb,
  p_authorization_id uuid,p_basket_fingerprint text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.sales%rowtype; v_customer public.customers%rowtype; v_credit numeric:=0;
  v_balance numeric:=0; v_due date; v_result jsonb; v_sale_id uuid; v_receipt text;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true,'change',0,'creditAmount',v_existing.credit_amount,'dueOn',v_existing.due_on); end if;
  select coalesce(sum((payment->>'amount')::numeric),0) into v_credit
    from jsonb_array_elements(p_payments) payment where upper(payment->>'method')='CREDIT';
  if v_credit>0 then
    if p_customer_id is null then raise exception 'Penjualan kredit wajib memilih pelanggan terdaftar'; end if;
    select * into v_customer from public.customers where id=p_customer_id and tenant_id=p_tenant_id and active=true for update;
    if not found then raise exception 'Pelanggan kredit tidak ditemukan'; end if;
    if not v_customer.credit_enabled then raise exception 'Fasilitas kredit pelanggan belum diaktifkan'; end if;
    select coalesce(sum(amount),0) into v_balance from public.customer_account_entries where tenant_id=p_tenant_id and customer_id=p_customer_id;
    if v_balance+v_credit>v_customer.credit_limit then raise exception 'Transaksi melewati batas kredit. Sisa plafon %',greatest(v_customer.credit_limit-v_balance,0); end if;
    v_due:=current_date+v_customer.credit_days;
  end if;
  v_result:=public.complete_sale_v4(p_tenant_id,p_actor_id,p_idempotency_key,p_outlet_id,p_shift_id,p_customer_id,p_customer_group_id,p_payments,p_quote,p_authorization_id,p_basket_fingerprint);
  v_sale_id:=(v_result->>'id')::uuid; v_receipt:=v_result->>'receiptNo';
  update public.sales set credit_amount=v_credit,due_on=v_due,account_status=case when v_credit>0 then 'OPEN' else 'PAID' end where id=v_sale_id;
  if v_credit>0 then
    insert into public.customer_account_entries(tenant_id,customer_id,entry_type,amount,balance_after,reference_type,reference_id,document_no,due_on,note,actor_id,idempotency_key)
    values(p_tenant_id,p_customer_id,'SALE_CREDIT',v_credit,v_balance+v_credit,'SALE',v_sale_id,v_receipt,v_due,'Penjualan kredit',p_actor_id,p_idempotency_key||':account');
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'CUSTOMER_CREDIT_CREATED','sale',v_sale_id,jsonb_build_object('customerId',p_customer_id,'creditAmount',v_credit,'balanceAfter',v_balance+v_credit,'dueOn',v_due));
  end if;
  return v_result||jsonb_build_object('creditAmount',v_credit,'dueOn',v_due,'accountBalance',case when v_credit>0 then v_balance+v_credit else null end);
end $$;

create or replace function public.record_customer_payment(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_customer_id uuid,p_outlet_id uuid,
  p_shift_id uuid,p_amount numeric,p_method text,p_reference text,p_note text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.customer_payment_receipts%rowtype; v_customer public.customers%rowtype;
  v_balance numeric; v_after numeric; v_method text:=upper(trim(p_method)); v_seq bigint;
  v_no text; v_payment uuid; v_remaining numeric; v_take numeric; v_sale public.sales%rowtype;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in ('OWNER','ADMIN','CASHIER'))
    then raise exception 'Akun tidak dapat menerima pembayaran pelanggan'; end if;
  select * into v_existing from public.customer_payment_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'amount',v_existing.amount,'duplicate',true); end if;
  select * into v_customer from public.customers where id=p_customer_id and tenant_id=p_tenant_id and active=true for update;
  if not found then raise exception 'Pelanggan tidak ditemukan'; end if;
  select coalesce(sum(amount),0) into v_balance from public.customer_account_entries where tenant_id=p_tenant_id and customer_id=p_customer_id;
  if coalesce(p_amount,0)<=0 then raise exception 'Nominal pembayaran harus lebih dari nol'; end if;
  if p_amount>v_balance then raise exception 'Pembayaran melebihi saldo piutang %',v_balance; end if;
  if v_method not in ('CASH','QRIS','TRANSFER','EDC') then raise exception 'Metode pembayaran tidak valid'; end if;
  if v_method<>'CASH' and nullif(trim(p_reference),'') is null then raise exception 'Referensi pembayaran non-tunai wajib diisi'; end if;
  if v_method='CASH' and not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN')
    then raise exception 'Pembayaran tunai wajib memakai shift aktif pengguna'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'CUSTOMER_PAYMENT',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='BYP-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0'); v_after:=v_balance-p_amount;
  insert into public.customer_payment_receipts(tenant_id,customer_id,outlet_id,receipt_no,idempotency_key,amount,method,reference,shift_id,actor_id)
  values(p_tenant_id,p_customer_id,p_outlet_id,v_no,p_idempotency_key,p_amount,v_method,nullif(trim(p_reference),''),case when v_method='CASH' then p_shift_id else null end,p_actor_id) returning id into v_payment;
  insert into public.customer_account_entries(tenant_id,customer_id,entry_type,amount,balance_after,reference_type,reference_id,document_no,note,actor_id,idempotency_key)
  values(p_tenant_id,p_customer_id,'PAYMENT',-p_amount,v_after,'CUSTOMER_PAYMENT',v_payment,v_no,nullif(trim(p_note),''),p_actor_id,p_idempotency_key||':account');
  v_remaining:=p_amount;
  for v_sale in select * from public.sales where tenant_id=p_tenant_id and customer_id=p_customer_id and account_status in ('OPEN','PARTIAL','OVERDUE') and credit_amount>paid_credit_amount order by due_on asc nulls last,occurred_at asc,id for update loop
    exit when v_remaining<=0;
    v_take:=least(v_remaining,v_sale.credit_amount-v_sale.paid_credit_amount);
    insert into public.customer_payment_allocations(tenant_id,payment_receipt_id,sale_id,amount) values(p_tenant_id,v_payment,v_sale.id,v_take);
    update public.sales set paid_credit_amount=paid_credit_amount+v_take,
      account_status=case when paid_credit_amount+v_take>=credit_amount then 'PAID' else 'PARTIAL' end where id=v_sale.id;
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_method='CASH' then
    insert into public.cash_movements(tenant_id,shift_id,movement_type,amount,note,actor_id,reference_type,reference_id)
    values(p_tenant_id,p_shift_id,'CASH_IN',p_amount,'Pembayaran piutang '||v_no,p_actor_id,'CUSTOMER_PAYMENT',v_payment);
  end if;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'CUSTOMER_PAYMENT_RECORDED','customer_payment',v_payment,jsonb_build_object('customerId',p_customer_id,'receiptNo',v_no,'amount',p_amount,'method',v_method,'balanceAfter',v_after));
  return jsonb_build_object('id',v_payment,'receiptNo',v_no,'amount',p_amount,'method',v_method,'balanceBefore',v_balance,'balanceAfter',v_after,'duplicate',false);
end $$;

revoke all on function public.save_customer_profile(uuid,uuid,uuid,text,text,text,text,text,boolean,numeric,integer,text,boolean) from public,anon,authenticated;
revoke all on function public.complete_sale_v5(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text) from public,anon,authenticated;
revoke all on function public.record_customer_payment(uuid,uuid,text,uuid,uuid,uuid,numeric,text,text,text) from public,anon,authenticated;
grant execute on function public.save_customer_profile(uuid,uuid,uuid,text,text,text,text,text,boolean,numeric,integer,text,boolean) to service_role;
grant execute on function public.complete_sale_v5(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text) to service_role;
grant execute on function public.record_customer_payment(uuid,uuid,text,uuid,uuid,uuid,numeric,text,text,text) to service_role;
grant select,insert,update on public.customer_account_entries,public.customer_payment_receipts,public.customer_payment_allocations to service_role;
