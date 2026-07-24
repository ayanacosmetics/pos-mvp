-- Kasir Nusa v1.16 - faktur dan hutang supplier

alter table public.suppliers add column if not exists email text;
alter table public.suppliers add column if not exists payment_terms_days integer not null default 0;

create table if not exists public.supplier_bills(
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),receipt_id uuid not null references public.purchase_receipts(id),
  document_no text not null,original_amount numeric(19,4) not null default 0,return_credit_amount numeric(19,4) not null default 0,
  paid_amount numeric(19,4) not null default 0,due_on date,status text not null default 'OPEN',
  occurred_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(tenant_id,receipt_id),check(status in('OPEN','PARTIAL','PAID','OVERDUE'))
);
create table if not exists public.supplier_payable_entries(
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),entry_type text not null check(entry_type in('BILL','PAYMENT','RETURN_CREDIT','ADJUSTMENT')),
  amount numeric(19,4) not null,reference_type text not null,reference_id uuid not null,document_no text,note text,
  actor_id uuid references public.profiles(user_id),occurred_at timestamptz not null default now(),
  unique(tenant_id,entry_type,reference_id)
);
create table if not exists public.supplier_payment_receipts(
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),outlet_id uuid not null references public.outlets(id),
  payment_no text not null,idempotency_key text not null,amount numeric(19,4) not null check(amount>0),
  method text not null check(method in('CASH','TRANSFER','QRIS','EDC')),reference text,shift_id uuid references public.shifts(id),
  actor_id uuid not null references public.profiles(user_id),occurred_at timestamptz not null default now(),
  unique(tenant_id,payment_no),unique(tenant_id,idempotency_key)
);
create table if not exists public.supplier_payment_allocations(
  id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,
  payment_id uuid not null references public.supplier_payment_receipts(id) on delete cascade,
  bill_id uuid not null references public.supplier_bills(id),amount numeric(19,4) not null check(amount>0),
  unique(payment_id,bill_id)
);
alter table public.supplier_bills enable row level security;
alter table public.supplier_payable_entries enable row level security;
alter table public.supplier_payment_receipts enable row level security;
alter table public.supplier_payment_allocations enable row level security;

create or replace function public.sync_supplier_bill(p_receipt_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare v_receipt public.purchase_receipts%rowtype;v_supplier public.suppliers%rowtype;v_original numeric;v_return numeric;v_bill uuid;
begin
  select * into v_receipt from public.purchase_receipts where id=p_receipt_id;
  if not found or v_receipt.supplier_id is null then return;end if;
  select * into v_supplier from public.suppliers where id=v_receipt.supplier_id;
  select coalesce(sum(base_qty*unit_cost),0) into v_original from public.purchase_receipt_items where receipt_id=p_receipt_id;
  select coalesce(sum(total_credit),0) into v_return from public.supplier_returns
    where receipt_id=p_receipt_id and status='POSTED' and settlement_type='CREDIT_NOTE';
  insert into public.supplier_bills(tenant_id,supplier_id,receipt_id,document_no,original_amount,return_credit_amount,due_on,occurred_at)
  values(v_receipt.tenant_id,v_receipt.supplier_id,p_receipt_id,v_receipt.document_no,v_original,v_return,
    (v_receipt.occurred_at at time zone 'UTC')::date+coalesce(v_supplier.payment_terms_days,0),v_receipt.occurred_at)
  on conflict(tenant_id,receipt_id) do update set original_amount=excluded.original_amount,
    return_credit_amount=excluded.return_credit_amount,updated_at=now(),
    status=case when public.supplier_bills.paid_amount+excluded.return_credit_amount>=excluded.original_amount then 'PAID'
      when public.supplier_bills.paid_amount>0 or excluded.return_credit_amount>0 then 'PARTIAL' else 'OPEN' end
  returning id into v_bill;
  insert into public.supplier_payable_entries(tenant_id,supplier_id,entry_type,amount,reference_type,reference_id,document_no,occurred_at)
  values(v_receipt.tenant_id,v_receipt.supplier_id,'BILL',v_original,'PURCHASE_RECEIPT',p_receipt_id,v_receipt.document_no,v_receipt.occurred_at)
  on conflict(tenant_id,entry_type,reference_id) do update set amount=excluded.amount;
  if v_return>0 then
    insert into public.supplier_payable_entries(tenant_id,supplier_id,entry_type,amount,reference_type,reference_id,document_no,note)
    values(v_receipt.tenant_id,v_receipt.supplier_id,'RETURN_CREDIT',-v_return,'SUPPLIER_BILL',v_bill,v_receipt.document_no,'Nota kredit retur supplier')
    on conflict(tenant_id,entry_type,reference_id) do update set amount=excluded.amount;
  end if;
end $$;

create or replace function public.sync_supplier_bill_trigger() returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform public.sync_supplier_bill(case when tg_table_name='purchase_receipt_items' then case when tg_op='DELETE' then old.receipt_id else new.receipt_id end when tg_table_name='supplier_returns' then new.receipt_id else new.id end);
 if tg_op='DELETE' then return old;end if;return new;
end $$;
drop trigger if exists sync_bill_on_receipt on public.purchase_receipts;
create trigger sync_bill_on_receipt after insert or update on public.purchase_receipts for each row execute function public.sync_supplier_bill_trigger();
drop trigger if exists sync_bill_on_receipt_item on public.purchase_receipt_items;
create trigger sync_bill_on_receipt_item after insert or update or delete on public.purchase_receipt_items for each row execute function public.sync_supplier_bill_trigger();
drop trigger if exists sync_bill_on_supplier_return on public.supplier_returns;
create trigger sync_bill_on_supplier_return after insert or update on public.supplier_returns for each row execute function public.sync_supplier_bill_trigger();

insert into public.supplier_bills(tenant_id,supplier_id,receipt_id,document_no,original_amount,return_credit_amount,due_on,occurred_at)
select r.tenant_id,r.supplier_id,r.id,r.document_no,coalesce(sum(i.base_qty*i.unit_cost),0),
  coalesce((select sum(sr.total_credit) from public.supplier_returns sr where sr.receipt_id=r.id and sr.status='POSTED' and sr.settlement_type='CREDIT_NOTE'),0),
  (r.occurred_at at time zone 'UTC')::date+coalesce(s.payment_terms_days,0),r.occurred_at
from public.purchase_receipts r join public.suppliers s on s.id=r.supplier_id left join public.purchase_receipt_items i on i.receipt_id=r.id
group by r.id,s.payment_terms_days on conflict(tenant_id,receipt_id) do nothing;
insert into public.supplier_payable_entries(tenant_id,supplier_id,entry_type,amount,reference_type,reference_id,document_no,occurred_at)
select b.tenant_id,b.supplier_id,'BILL',b.original_amount,'PURCHASE_RECEIPT',b.receipt_id,b.document_no,b.occurred_at
from public.supplier_bills b on conflict(tenant_id,entry_type,reference_id) do nothing;
insert into public.supplier_payable_entries(tenant_id,supplier_id,entry_type,amount,reference_type,reference_id,document_no,note)
select b.tenant_id,b.supplier_id,'RETURN_CREDIT',-b.return_credit_amount,'SUPPLIER_BILL',b.id,b.document_no,'Nota kredit retur supplier'
from public.supplier_bills b where b.return_credit_amount>0 on conflict(tenant_id,entry_type,reference_id) do nothing;

create or replace function public.record_supplier_payment(
 p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_supplier_id uuid,p_outlet_id uuid,
 p_shift_id uuid,p_amount numeric,p_method text,p_reference text,p_note text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_existing public.supplier_payment_receipts%rowtype;v_balance numeric;v_method text:=upper(trim(p_method));
v_seq bigint;v_no text;v_payment uuid;v_remaining numeric;v_take numeric;v_bill public.supplier_bills%rowtype;
begin
 if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN','PURCHASING')) then raise exception 'Akun tidak dapat membayar supplier';end if;
 select * into v_existing from public.supplier_payment_receipts where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
 if found then return jsonb_build_object('id',v_existing.id,'paymentNo',v_existing.payment_no,'duplicate',true);end if;
 select coalesce(sum(greatest(original_amount-return_credit_amount-paid_amount,0)),0) into v_balance from public.supplier_bills where tenant_id=p_tenant_id and supplier_id=p_supplier_id;
 if coalesce(p_amount,0)<=0 or p_amount>v_balance then raise exception 'Pembayaran tidak valid atau melebihi saldo hutang %',v_balance;end if;
 if v_method not in('CASH','TRANSFER','QRIS','EDC') then raise exception 'Metode pembayaran tidak valid';end if;
 if v_method<>'CASH' and nullif(trim(p_reference),'') is null then raise exception 'Referensi pembayaran wajib diisi';end if;
 if v_method='CASH' and not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN') then raise exception 'Pembayaran tunai wajib memakai shift aktif';end if;
 insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SUPPLIER_PAYMENT',2)
 on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
 v_no:='BYS-'||to_char(current_date,'YYMM')||'-'||lpad(v_seq::text,5,'0');
 insert into public.supplier_payment_receipts(tenant_id,supplier_id,outlet_id,payment_no,idempotency_key,amount,method,reference,shift_id,actor_id)
 values(p_tenant_id,p_supplier_id,p_outlet_id,v_no,p_idempotency_key,p_amount,v_method,nullif(trim(p_reference),''),case when v_method='CASH' then p_shift_id else null end,p_actor_id) returning id into v_payment;
 v_remaining:=p_amount;
 for v_bill in select * from public.supplier_bills where tenant_id=p_tenant_id and supplier_id=p_supplier_id and original_amount>return_credit_amount+paid_amount order by due_on,occurred_at,id for update loop
  exit when v_remaining<=0;v_take:=least(v_remaining,v_bill.original_amount-v_bill.return_credit_amount-v_bill.paid_amount);
  insert into public.supplier_payment_allocations(tenant_id,payment_id,bill_id,amount) values(p_tenant_id,v_payment,v_bill.id,v_take);
  update public.supplier_bills set paid_amount=paid_amount+v_take,status=case when paid_amount+v_take+return_credit_amount>=original_amount then 'PAID' else 'PARTIAL' end,updated_at=now() where id=v_bill.id;
  v_remaining:=v_remaining-v_take;
 end loop;
 insert into public.supplier_payable_entries(tenant_id,supplier_id,entry_type,amount,reference_type,reference_id,document_no,note,actor_id)
 values(p_tenant_id,p_supplier_id,'PAYMENT',-p_amount,'SUPPLIER_PAYMENT',v_payment,v_no,nullif(trim(p_note),''),p_actor_id);
 if v_method='CASH' then insert into public.cash_movements(tenant_id,shift_id,movement_type,amount,note,actor_id,reference_type,reference_id)
 values(p_tenant_id,p_shift_id,'CASH_OUT',p_amount,'Pembayaran supplier '||v_no,p_actor_id,'SUPPLIER_PAYMENT',v_payment);end if;
 insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,'SUPPLIER_PAYMENT_RECORDED','supplier_payment',v_payment,jsonb_build_object('supplierId',p_supplier_id,'paymentNo',v_no,'amount',p_amount,'method',v_method,'balanceAfter',v_balance-p_amount));
 return jsonb_build_object('id',v_payment,'paymentNo',v_no,'amount',p_amount,'balanceAfter',v_balance-p_amount,'duplicate',false);
end $$;
revoke all on function public.record_supplier_payment(uuid,uuid,text,uuid,uuid,uuid,numeric,text,text,text) from public,anon,authenticated;
grant execute on function public.record_supplier_payment(uuid,uuid,text,uuid,uuid,uuid,numeric,text,text,text) to service_role;
grant select,insert,update on public.supplier_bills,public.supplier_payable_entries,public.supplier_payment_receipts,public.supplier_payment_allocations to service_role;
