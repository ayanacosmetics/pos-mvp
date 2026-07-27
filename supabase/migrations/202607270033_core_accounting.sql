-- Kasir Nusa POS v2.1 - core double-entry accounting

create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null check(account_type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text not null check(normal_balance in ('DEBIT','CREDIT')),
  system_key text,
  allow_manual boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,code),
  unique(tenant_id,system_key)
);

create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'OPEN' check(status in ('OPEN','CLOSED')),
  closed_by uuid references public.profiles(user_id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check(ends_on>=starts_on),
  unique(tenant_id,starts_on,ends_on)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entry_no text not null,
  entry_date date not null,
  description text not null,
  source_type text not null,
  source_id uuid,
  status text not null default 'POSTED' check(status in ('POSTED','REVERSED')),
  reversal_of uuid references public.journal_entries(id),
  actor_id uuid references public.profiles(user_id),
  posted_at timestamptz not null default now(),
  unique(tenant_id,entry_no)
);

create unique index if not exists journal_entries_source_once
  on public.journal_entries(tenant_id,source_type,source_id)
  where source_id is not null;
create index if not exists journal_entries_report_idx
  on public.journal_entries(tenant_id,entry_date desc,posted_at desc);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.chart_of_accounts(id),
  outlet_id uuid references public.outlets(id),
  memo text,
  debit numeric(19,4) not null default 0 check(debit>=0),
  credit numeric(19,4) not null default 0 check(credit>=0),
  created_at timestamptz not null default now(),
  check((debit>0 and credit=0) or (credit>0 and debit=0))
);

create index if not exists journal_lines_ledger_idx
  on public.journal_lines(tenant_id,account_id,journal_entry_id);

alter table public.chart_of_accounts enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

drop policy if exists chart_of_accounts_owner_read on public.chart_of_accounts;
create policy chart_of_accounts_owner_read on public.chart_of_accounts for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');
drop policy if exists accounting_periods_owner_read on public.accounting_periods;
create policy accounting_periods_owner_read on public.accounting_periods for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');
drop policy if exists journal_entries_owner_read on public.journal_entries;
create policy journal_entries_owner_read on public.journal_entries for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');
drop policy if exists journal_lines_owner_read on public.journal_lines;
create policy journal_lines_owner_read on public.journal_lines for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');

insert into public.chart_of_accounts(tenant_id,code,name,account_type,normal_balance,system_key,allow_manual)
select tenant.id,seed.code,seed.name,seed.account_type,seed.normal_balance,seed.system_key,seed.allow_manual
from public.tenants tenant cross join (values
  ('1100','Kas Tunai','ASSET','DEBIT','CASH',true),
  ('1110','Bank dan Transfer','ASSET','DEBIT','BANK',true),
  ('1120','QRIS Belum Cair','ASSET','DEBIT','QRIS_CLEARING',true),
  ('1130','Kartu/EDC Belum Cair','ASSET','DEBIT','CARD_CLEARING',true),
  ('1200','Piutang Usaha','ASSET','DEBIT','ACCOUNTS_RECEIVABLE',true),
  ('1300','Persediaan Barang','ASSET','DEBIT','INVENTORY',true),
  ('1400','Uang Muka dan Klaim Supplier','ASSET','DEBIT','SUPPLIER_ADVANCE',true),
  ('2100','Hutang Usaha','LIABILITY','CREDIT','ACCOUNTS_PAYABLE',true),
  ('3100','Modal Pemilik','EQUITY','CREDIT','OWNER_EQUITY',true),
  ('3200','Saldo Laba','EQUITY','CREDIT','RETAINED_EARNINGS',true),
  ('4100','Penjualan','REVENUE','CREDIT','SALES_REVENUE',false),
  ('4190','Retur Penjualan','REVENUE','DEBIT','SALES_RETURN',false),
  ('5100','Harga Pokok Penjualan','EXPENSE','DEBIT','COGS',false),
  ('6100','Biaya Operasional','EXPENSE','DEBIT','OPERATING_EXPENSE',true),
  ('6900','Kerugian Persediaan','EXPENSE','DEBIT','INVENTORY_LOSS',true)
) as seed(code,name,account_type,normal_balance,system_key,allow_manual)
on conflict(tenant_id,code) do update set
  name=excluded.name,account_type=excluded.account_type,normal_balance=excluded.normal_balance,
  system_key=excluded.system_key,allow_manual=excluded.allow_manual,updated_at=now();

create or replace function public.post_system_journal_v1(
  p_tenant_id uuid,p_actor_id uuid,p_source_type text,p_source_id uuid,p_entry_date date,
  p_description text,p_lines jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_id uuid;v_line jsonb;v_account uuid;v_debit numeric;v_credit numeric;
  v_total_debit numeric:=0;v_total_credit numeric:=0;v_seq bigint;v_no text;
begin
  select id into v_id from journal_entries
    where tenant_id=p_tenant_id and source_type=p_source_type and source_id=p_source_id;
  if v_id is not null then return v_id;end if;
  if exists(select 1 from accounting_periods where tenant_id=p_tenant_id and status='CLOSED'
    and p_entry_date between starts_on and ends_on) then
    raise exception 'Transaksi bertanggal pada periode akuntansi yang sudah ditutup';
  end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)<2 then
    raise exception 'Jurnal minimal memiliki dua baris';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_debit:=coalesce((v_line->>'debit')::numeric,0);
    v_credit:=coalesce((v_line->>'credit')::numeric,0);
    if (v_debit>0)=(v_credit>0) then raise exception 'Setiap baris jurnal harus debit atau kredit';end if;
    v_total_debit:=v_total_debit+v_debit;v_total_credit:=v_total_credit+v_credit;
  end loop;
  if round(v_total_debit,2)<>round(v_total_credit,2) or v_total_debit<=0 then
    raise exception 'Jurnal tidak seimbang: debit %, kredit %',v_total_debit,v_total_credit;
  end if;
  insert into document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'JOURNAL',2)
  on conflict(tenant_id,kind) do update set next_value=document_sequences.next_value+1
  returning next_value-1 into v_seq;
  v_no:='JU-'||to_char(p_entry_date,'YYMM')||'-'||lpad(v_seq::text,6,'0');
  insert into journal_entries(tenant_id,entry_no,entry_date,description,source_type,source_id,actor_id)
    values(p_tenant_id,v_no,p_entry_date,left(trim(p_description),240),p_source_type,p_source_id,p_actor_id)
    returning id into v_id;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select id into v_account from chart_of_accounts
      where tenant_id=p_tenant_id and system_key=v_line->>'accountKey' and active=true;
    if v_account is null then raise exception 'Akun sistem % tidak ditemukan',v_line->>'accountKey';end if;
    insert into journal_lines(tenant_id,journal_entry_id,account_id,outlet_id,memo,debit,credit)
    values(p_tenant_id,v_id,v_account,nullif(v_line->>'outletId','')::uuid,
      nullif(left(trim(coalesce(v_line->>'memo','')),240),''),
      coalesce((v_line->>'debit')::numeric,0),coalesce((v_line->>'credit')::numeric,0));
  end loop;
  return v_id;
end $$;

create or replace function public.reverse_system_journal_v1(
  p_tenant_id uuid,p_actor_id uuid,p_original_type text,p_source_id uuid,
  p_reversal_type text,p_entry_date date,p_description text
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_original uuid;v_lines jsonb;
begin
  select id into v_original from journal_entries
    where tenant_id=p_tenant_id and source_type=p_original_type and source_id=p_source_id;
  if v_original is null then return null;end if;
  select jsonb_agg(jsonb_build_object('accountKey',account.system_key,'outletId',line.outlet_id,
    'memo','Pembalikan '||entry.entry_no,'debit',line.credit,'credit',line.debit))
  into v_lines from journal_lines line join chart_of_accounts account on account.id=line.account_id
    join journal_entries entry on entry.id=line.journal_entry_id where line.journal_entry_id=v_original;
  return post_system_journal_v1(p_tenant_id,p_actor_id,p_reversal_type,p_source_id,p_entry_date,p_description,v_lines);
end $$;

create or replace function public.sync_accounting_v1(
  p_tenant_id uuid,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale record;v_payment record;v_return record;v_receipt record;v_expense record;
  v_customer_payment record;v_supplier_payment record;v_supplier_return record;
  v_lines jsonb;v_asset text;v_count integer:=0;v_cost numeric;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat menyinkronkan akuntansi';end if;

  for v_sale in select * from sales where tenant_id=p_tenant_id order by occurred_at,id loop
    v_lines:='[]'::jsonb;
    for v_payment in select method,sum(amount) amount from payments
      where tenant_id=p_tenant_id and sale_id=v_sale.id group by method loop
      v_asset:=case upper(v_payment.method) when 'CASH' then 'CASH' when 'CREDIT' then 'ACCOUNTS_RECEIVABLE'
        when 'QRIS' then 'QRIS_CLEARING' when 'EDC' then 'CARD_CLEARING' else 'BANK' end;
      if v_payment.amount>0 then v_lines:=v_lines||jsonb_build_array(jsonb_build_object(
        'accountKey',v_asset,'outletId',v_sale.outlet_id,'debit',v_payment.amount,'credit',0,'memo',upper(v_payment.method)));end if;
    end loop;
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('accountKey','SALES_REVENUE','outletId',v_sale.outlet_id,
      'debit',0,'credit',v_sale.grand_total,'memo',v_sale.receipt_no));
    if v_sale.cost_total>0 then v_lines:=v_lines||jsonb_build_array(
      jsonb_build_object('accountKey','COGS','outletId',v_sale.outlet_id,'debit',v_sale.cost_total,'credit',0),
      jsonb_build_object('accountKey','INVENTORY','outletId',v_sale.outlet_id,'debit',0,'credit',v_sale.cost_total));end if;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'SALE',v_sale.id,(v_sale.occurred_at at time zone 'UTC')::date,
      'Penjualan '||v_sale.receipt_no,v_lines);v_count:=v_count+1;
    if v_sale.status='VOIDED' then
      perform reverse_system_journal_v1(p_tenant_id,p_actor_id,'SALE',v_sale.id,'SALE_VOID',
        (coalesce(v_sale.voided_at,v_sale.occurred_at) at time zone 'UTC')::date,'Pembatalan penjualan '||v_sale.receipt_no);
    end if;
  end loop;

  for v_return in select r.*,s.outlet_id from customer_returns r join sales s on s.id=r.sale_id
    where r.tenant_id=p_tenant_id and r.status='COMPLETED' loop
    v_asset:=case upper(coalesce(v_return.refund_method,'TRANSFER')) when 'CASH' then 'CASH'
      when 'CREDIT' then 'ACCOUNTS_RECEIVABLE' when 'QRIS' then 'QRIS_CLEARING'
      when 'EDC' then 'CARD_CLEARING' else 'BANK' end;
    select coalesce(sum(case when restockable then base_qty*original_unit_cost else 0 end),0) into v_cost
      from customer_return_items where tenant_id=p_tenant_id and return_id=v_return.id;
    v_lines:=jsonb_build_array(
      jsonb_build_object('accountKey','SALES_RETURN','outletId',v_return.outlet_id,'debit',v_return.total,'credit',0),
      jsonb_build_object('accountKey',v_asset,'outletId',v_return.outlet_id,'debit',0,'credit',v_return.total));
    if v_cost>0 then v_lines:=v_lines||jsonb_build_array(
      jsonb_build_object('accountKey','INVENTORY','outletId',v_return.outlet_id,'debit',v_cost,'credit',0),
      jsonb_build_object('accountKey','COGS','outletId',v_return.outlet_id,'debit',0,'credit',v_cost));end if;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'CUSTOMER_RETURN',v_return.id,
      (v_return.occurred_at at time zone 'UTC')::date,'Retur penjualan '||v_return.return_no,v_lines);
  end loop;

  for v_receipt in select receipt.*,location.outlet_id,
      coalesce((select sum(item.base_qty*item.unit_cost) from purchase_receipt_items item where item.receipt_id=receipt.id),0) total
    from purchase_receipts receipt join stock_locations location on location.id=receipt.location_id
    where receipt.tenant_id=p_tenant_id and receipt.status='RECEIVED' loop
    if v_receipt.total>0 then
      perform post_system_journal_v1(p_tenant_id,p_actor_id,'PURCHASE_RECEIPT',v_receipt.id,
        (v_receipt.occurred_at at time zone 'UTC')::date,'Penerimaan '||v_receipt.document_no,jsonb_build_array(
          jsonb_build_object('accountKey','INVENTORY','outletId',v_receipt.outlet_id,'debit',v_receipt.total,'credit',0),
          jsonb_build_object('accountKey','ACCOUNTS_PAYABLE','outletId',v_receipt.outlet_id,'debit',0,'credit',v_receipt.total)));
    end if;
  end loop;

  for v_customer_payment in select * from customer_payment_receipts where tenant_id=p_tenant_id loop
    v_asset:=case upper(v_customer_payment.method) when 'CASH' then 'CASH' when 'QRIS' then 'QRIS_CLEARING'
      when 'EDC' then 'CARD_CLEARING' else 'BANK' end;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'CUSTOMER_PAYMENT',v_customer_payment.id,
      (v_customer_payment.occurred_at at time zone 'UTC')::date,'Pembayaran piutang '||v_customer_payment.receipt_no,jsonb_build_array(
        jsonb_build_object('accountKey',v_asset,'outletId',v_customer_payment.outlet_id,'debit',v_customer_payment.amount,'credit',0),
        jsonb_build_object('accountKey','ACCOUNTS_RECEIVABLE','outletId',v_customer_payment.outlet_id,'debit',0,'credit',v_customer_payment.amount)));
  end loop;

  for v_supplier_payment in select * from supplier_payment_receipts where tenant_id=p_tenant_id loop
    v_asset:=case upper(v_supplier_payment.method) when 'CASH' then 'CASH' when 'QRIS' then 'QRIS_CLEARING'
      when 'EDC' then 'CARD_CLEARING' else 'BANK' end;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'SUPPLIER_PAYMENT',v_supplier_payment.id,
      (v_supplier_payment.occurred_at at time zone 'UTC')::date,'Pembayaran supplier '||v_supplier_payment.payment_no,jsonb_build_array(
        jsonb_build_object('accountKey','ACCOUNTS_PAYABLE','outletId',v_supplier_payment.outlet_id,'debit',v_supplier_payment.amount,'credit',0),
        jsonb_build_object('accountKey',v_asset,'outletId',v_supplier_payment.outlet_id,'debit',0,'credit',v_supplier_payment.amount)));
  end loop;

  for v_supplier_return in select r.*,location.outlet_id from supplier_returns r
    join stock_locations location on location.id=r.location_id
    where r.tenant_id=p_tenant_id and r.status='POSTED' loop
    v_asset:=case v_supplier_return.settlement_type
      when 'CREDIT_NOTE' then 'ACCOUNTS_PAYABLE'
      when 'REPLACEMENT' then 'SUPPLIER_ADVANCE'
      else 'BANK' end;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'SUPPLIER_RETURN',v_supplier_return.id,
      (v_supplier_return.occurred_at at time zone 'UTC')::date,'Retur supplier '||v_supplier_return.return_no,jsonb_build_array(
        jsonb_build_object('accountKey',v_asset,'outletId',v_supplier_return.outlet_id,'debit',v_supplier_return.total_credit,'credit',0),
        jsonb_build_object('accountKey','INVENTORY','outletId',v_supplier_return.outlet_id,'debit',0,'credit',v_supplier_return.total_credit)));
  end loop;

  for v_expense in select * from outlet_expenses where tenant_id=p_tenant_id loop
    v_asset:=case upper(v_expense.payment_method) when 'CASH' then 'CASH' when 'QRIS' then 'QRIS_CLEARING'
      when 'EDC' then 'CARD_CLEARING' else 'BANK' end;
    perform post_system_journal_v1(p_tenant_id,p_actor_id,'OUTLET_EXPENSE',v_expense.id,v_expense.occurred_on,
      'Biaya '||v_expense.expense_no,jsonb_build_array(
        jsonb_build_object('accountKey','OPERATING_EXPENSE','outletId',v_expense.outlet_id,'debit',v_expense.amount,'credit',0),
        jsonb_build_object('accountKey',v_asset,'outletId',v_expense.outlet_id,'debit',0,'credit',v_expense.amount)));
    if v_expense.status='VOIDED' then
      perform reverse_system_journal_v1(p_tenant_id,p_actor_id,'OUTLET_EXPENSE',v_expense.id,'OUTLET_EXPENSE_VOID',
        (coalesce(v_expense.voided_at,v_expense.created_at) at time zone 'UTC')::date,'Pembatalan biaya '||v_expense.expense_no);
    end if;
  end loop;
  return jsonb_build_object('synced',true,'salesScanned',v_count,'syncedAt',now());
end $$;

create or replace function public.post_manual_journal_v1(
  p_tenant_id uuid,p_actor_id uuid,p_entry_date date,p_description text,p_lines jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_actor profiles%rowtype;v_line jsonb;v_account chart_of_accounts%rowtype;v_id uuid;
  v_debit numeric;v_credit numeric;v_total_debit numeric:=0;v_total_credit numeric:=0;
  v_seq bigint;v_no text;
begin
  select * into v_actor from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER';
  if not found then raise exception 'Hanya Owner yang dapat membuat jurnal manual';end if;
  if exists(select 1 from accounting_periods where tenant_id=p_tenant_id and status='CLOSED'
    and p_entry_date between starts_on and ends_on) then raise exception 'Periode akuntansi sudah ditutup';end if;
  if nullif(trim(p_description),'') is null then raise exception 'Keterangan jurnal wajib diisi';end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)<2 then raise exception 'Jurnal minimal memiliki dua baris';end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_account from chart_of_accounts where tenant_id=p_tenant_id
      and id=(v_line->>'accountId')::uuid and active and allow_manual;
    if not found then raise exception 'Akun manual tidak valid';end if;
    v_debit:=coalesce((v_line->>'debit')::numeric,0);v_credit:=coalesce((v_line->>'credit')::numeric,0);
    if (v_debit>0)=(v_credit>0) then raise exception 'Setiap baris harus diisi pada debit atau kredit';end if;
    v_total_debit:=v_total_debit+v_debit;v_total_credit:=v_total_credit+v_credit;
  end loop;
  if round(v_total_debit,2)<>round(v_total_credit,2) then raise exception 'Total debit dan kredit harus sama';end if;
  insert into document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'JOURNAL',2)
  on conflict(tenant_id,kind) do update set next_value=document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='JU-'||to_char(p_entry_date,'YYMM')||'-'||lpad(v_seq::text,6,'0');
  insert into journal_entries(tenant_id,entry_no,entry_date,description,source_type,actor_id)
    values(p_tenant_id,v_no,p_entry_date,left(trim(p_description),240),'MANUAL',p_actor_id) returning id into v_id;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into journal_lines(tenant_id,journal_entry_id,account_id,outlet_id,memo,debit,credit)
    values(p_tenant_id,v_id,(v_line->>'accountId')::uuid,nullif(v_line->>'outletId','')::uuid,
      nullif(left(trim(coalesce(v_line->>'memo','')),240),''),
      coalesce((v_line->>'debit')::numeric,0),coalesce((v_line->>'credit')::numeric,0));
  end loop;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'MANUAL_JOURNAL_POSTED','journal_entry',v_id,
      jsonb_build_object('entryNo',v_no,'entryDate',p_entry_date,'debit',v_total_debit));
  return jsonb_build_object('id',v_id,'entryNo',v_no,'debit',v_total_debit,'credit',v_total_credit);
end $$;

create or replace function public.reverse_manual_journal_v1(
  p_tenant_id uuid,p_actor_id uuid,p_entry_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_original journal_entries%rowtype;v_id uuid;v_seq bigint;v_no text;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat membalik jurnal';end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Alasan pembalikan wajib diisi';end if;
  select * into v_original from journal_entries where tenant_id=p_tenant_id and id=p_entry_id and source_type='MANUAL' for update;
  if not found then raise exception 'Jurnal manual tidak ditemukan';end if;
  if v_original.status='REVERSED' then raise exception 'Jurnal sudah dibalik';end if;
  if exists(select 1 from accounting_periods where tenant_id=p_tenant_id and status='CLOSED'
    and current_date between starts_on and ends_on) then raise exception 'Periode hari ini sudah ditutup';end if;
  insert into document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'JOURNAL',2)
  on conflict(tenant_id,kind) do update set next_value=document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_no:='JU-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,6,'0');
  insert into journal_entries(tenant_id,entry_no,entry_date,description,source_type,status,reversal_of,actor_id)
    values(p_tenant_id,v_no,current_date,'Pembalikan '||v_original.entry_no||': '||left(trim(p_reason),180),
      'MANUAL_REVERSAL','POSTED',v_original.id,p_actor_id) returning id into v_id;
  insert into journal_lines(tenant_id,journal_entry_id,account_id,outlet_id,memo,debit,credit)
    select tenant_id,v_id,account_id,outlet_id,'Pembalikan '||v_original.entry_no,credit,debit
    from journal_lines where journal_entry_id=v_original.id;
  update journal_entries set status='REVERSED' where id=v_original.id;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'MANUAL_JOURNAL_REVERSED','journal_entry',v_original.id,
      jsonb_build_object('reversalId',v_id,'reason',trim(p_reason)));
  return jsonb_build_object('id',v_id,'entryNo',v_no,'reversalOf',v_original.id);
end $$;

create or replace function public.save_accounting_period_v1(
  p_tenant_id uuid,p_actor_id uuid,p_name text,p_starts_on date,p_ends_on date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_period accounting_periods%rowtype;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat mengelola periode';end if;
  if p_ends_on<p_starts_on then raise exception 'Akhir periode tidak valid';end if;
  if exists(select 1 from accounting_periods where tenant_id=p_tenant_id
    and daterange(starts_on,ends_on,'[]')&&daterange(p_starts_on,p_ends_on,'[]'))
    then raise exception 'Periode bertumpang tindih';end if;
  insert into accounting_periods(tenant_id,name,starts_on,ends_on)
    values(p_tenant_id,left(trim(p_name),80),p_starts_on,p_ends_on) returning * into v_period;
  return to_jsonb(v_period);
end $$;

create or replace function public.close_accounting_period_v1(
  p_tenant_id uuid,p_actor_id uuid,p_period_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_period accounting_periods%rowtype;v_unbalanced integer;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat menutup periode';end if;
  perform sync_accounting_v1(p_tenant_id,p_actor_id);
  select * into v_period from accounting_periods where tenant_id=p_tenant_id and id=p_period_id for update;
  if not found then raise exception 'Periode tidak ditemukan';end if;
  if v_period.status='CLOSED' then return to_jsonb(v_period);end if;
  if v_period.ends_on>current_date then raise exception 'Periode yang belum selesai tidak dapat ditutup';end if;
  select count(*) into v_unbalanced from (
    select entry.id from journal_entries entry join journal_lines line on line.journal_entry_id=entry.id
    where entry.tenant_id=p_tenant_id and entry.entry_date between v_period.starts_on and v_period.ends_on
    group by entry.id having round(sum(line.debit),2)<>round(sum(line.credit),2)
  ) issue;
  if v_unbalanced>0 then raise exception 'Masih ada jurnal tidak seimbang';end if;
  update accounting_periods set status='CLOSED',closed_by=p_actor_id,closed_at=now()
    where id=v_period.id returning * into v_period;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'ACCOUNTING_PERIOD_CLOSED','accounting_period',v_period.id,
      jsonb_build_object('startsOn',v_period.starts_on,'endsOn',v_period.ends_on));
  return to_jsonb(v_period);
end $$;

create or replace function public.report_core_accounting_v1(
  p_tenant_id uuid,p_actor_id uuid,p_from date,p_to date,p_account_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_accounts jsonb;v_periods jsonb;v_entries jsonb;v_trial jsonb;v_ledger jsonb;v_balance jsonb;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat melihat akuntansi';end if;
  if p_to<p_from then raise exception 'Periode laporan tidak valid';end if;
  select coalesce(jsonb_agg(to_jsonb(account) order by account.code),'[]') into v_accounts
    from chart_of_accounts account where tenant_id=p_tenant_id and active;
  select coalesce(jsonb_agg(to_jsonb(period) order by period.starts_on desc),'[]') into v_periods
    from accounting_periods period where tenant_id=p_tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',entry.id,'entryNo',entry.entry_no,'entryDate',entry.entry_date,'description',entry.description,
    'sourceType',entry.source_type,'status',entry.status,'reversalOf',entry.reversal_of,
    'debit',entry.debit,'credit',entry.credit) order by entry.entry_date desc,entry.posted_at desc),'[]')
  into v_entries from (
    select e.*,sum(l.debit) debit,sum(l.credit) credit from journal_entries e
    join journal_lines l on l.journal_entry_id=e.id where e.tenant_id=p_tenant_id
      and e.entry_date between p_from and p_to group by e.id order by e.entry_date desc,e.posted_at desc limit 200
  ) entry;
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId',account.id,'code',account.code,'name',account.name,'type',account.account_type,
    'normalBalance',account.normal_balance,'opening',coalesce(total.opening,0),
    'debit',coalesce(total.debit,0),'credit',coalesce(total.credit,0),
    'ending',coalesce(total.opening,0)+coalesce(total.debit,0)-coalesce(total.credit,0))
    order by account.code),'[]') into v_trial
  from chart_of_accounts account left join (
    select line.account_id,
      sum(case when entry.entry_date<p_from then line.debit-line.credit else 0 end) opening,
      sum(case when entry.entry_date between p_from and p_to then line.debit else 0 end) debit,
      sum(case when entry.entry_date between p_from and p_to then line.credit else 0 end) credit
    from journal_lines line join journal_entries entry on entry.id=line.journal_entry_id
    where line.tenant_id=p_tenant_id and entry.entry_date<=p_to group by line.account_id
  ) total on total.account_id=account.id where account.tenant_id=p_tenant_id and account.active;
  select coalesce(jsonb_agg(jsonb_build_object(
    'entryId',entry.id,'entryNo',entry.entry_no,'entryDate',entry.entry_date,'description',entry.description,
    'memo',line.memo,'debit',line.debit,'credit',line.credit,'outletId',line.outlet_id)
    order by entry.entry_date,entry.posted_at,line.id),'[]') into v_ledger
  from journal_lines line join journal_entries entry on entry.id=line.journal_entry_id
  where line.tenant_id=p_tenant_id and entry.entry_date between p_from and p_to
    and (p_account_id is null or line.account_id=p_account_id);
  select jsonb_build_object(
    'assets',coalesce(sum(case when account.account_type='ASSET' then line.debit-line.credit else 0 end),0),
    'liabilities',coalesce(sum(case when account.account_type='LIABILITY' then line.credit-line.debit else 0 end),0),
    'equity',coalesce(sum(case when account.account_type='EQUITY' then line.credit-line.debit else 0 end),0),
    'revenue',coalesce(sum(case when account.account_type='REVENUE' then line.credit-line.debit else 0 end),0),
    'expenses',coalesce(sum(case when account.account_type='EXPENSE' then line.debit-line.credit else 0 end),0),
    'asOf',p_to
  ) into v_balance from journal_lines line join journal_entries entry on entry.id=line.journal_entry_id
    join chart_of_accounts account on account.id=line.account_id
    where line.tenant_id=p_tenant_id and entry.entry_date<=p_to;
  return jsonb_build_object('period',jsonb_build_object('from',p_from,'to',p_to),
    'accounts',v_accounts,'periods',v_periods,'entries',v_entries,'trialBalance',v_trial,
    'ledger',v_ledger,'balanceSheet',v_balance,'generatedAt',now());
end $$;

revoke all on function public.post_system_journal_v1(uuid,uuid,text,uuid,date,text,jsonb) from public,anon,authenticated;
revoke all on function public.reverse_system_journal_v1(uuid,uuid,text,uuid,text,date,text) from public,anon,authenticated;
revoke all on function public.sync_accounting_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.post_manual_journal_v1(uuid,uuid,date,text,jsonb) from public,anon,authenticated;
revoke all on function public.reverse_manual_journal_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.save_accounting_period_v1(uuid,uuid,text,date,date) from public,anon,authenticated;
revoke all on function public.close_accounting_period_v1(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.report_core_accounting_v1(uuid,uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.sync_accounting_v1(uuid,uuid) to service_role;
grant execute on function public.post_manual_journal_v1(uuid,uuid,date,text,jsonb) to service_role;
grant execute on function public.reverse_manual_journal_v1(uuid,uuid,uuid,text) to service_role;
grant execute on function public.save_accounting_period_v1(uuid,uuid,text,date,date) to service_role;
grant execute on function public.close_accounting_period_v1(uuid,uuid,uuid) to service_role;
grant execute on function public.report_core_accounting_v1(uuid,uuid,date,date,uuid) to service_role;
grant select,insert,update on public.chart_of_accounts,public.accounting_periods,public.journal_entries,public.journal_lines to service_role;
