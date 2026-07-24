-- Kasir Nusa v1.15
-- Retur penjualan kredit dan laporan umur piutang.

alter table public.sales add column if not exists returned_credit_amount numeric(19,4) not null default 0;

create or replace function public.process_customer_return_v3(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_sale_id uuid,
  p_reason text,p_refund_method text,p_refund_reference text,p_refund_shift_id uuid,p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales%rowtype; v_method text:=upper(trim(coalesce(p_refund_method,'ORIGINAL')));
  v_result jsonb; v_total numeric; v_outstanding numeric; v_balance numeric; v_after numeric;
  v_return_id uuid;
begin
  select * into v_sale from public.sales where id=p_sale_id and tenant_id=p_tenant_id and status='COMPLETED' for update;
  if not found then raise exception 'Transaksi penjualan tidak ditemukan'; end if;
  if v_method='ORIGINAL' and v_sale.credit_amount>0 then v_method:='ACCOUNT_CREDIT'; end if;

  if v_method<>'ACCOUNT_CREDIT' then
    return public.process_customer_return_v2(
      p_tenant_id,p_actor_id,p_idempotency_key,p_sale_id,p_reason,v_method,
      p_refund_reference,p_refund_shift_id,p_items
    );
  end if;

  if v_sale.customer_id is null or v_sale.credit_amount<=0 then raise exception 'Transaksi ini tidak memiliki piutang pelanggan'; end if;
  v_outstanding:=greatest(v_sale.credit_amount-v_sale.paid_credit_amount-v_sale.returned_credit_amount,0);
  if v_outstanding<=0 then raise exception 'Piutang faktur ini sudah lunas; pilih refund tunai atau non-tunai'; end if;
  select coalesce(sum(amount),0) into v_balance from public.customer_account_entries
    where tenant_id=p_tenant_id and customer_id=v_sale.customer_id;

  v_result:=public.process_customer_return_v2(
    p_tenant_id,p_actor_id,p_idempotency_key,p_sale_id,p_reason,'TRANSFER',
    'ACCOUNT-CREDIT',null,p_items
  );
  if coalesce((v_result->>'duplicate')::boolean,false) then return v_result; end if;
  v_total:=(v_result->>'total')::numeric; v_return_id:=(v_result->>'id')::uuid;
  if v_total>v_outstanding then raise exception 'Nilai retur % melebihi sisa piutang faktur %. Pilih metode refund lain untuk selisihnya',v_total,v_outstanding; end if;
  if v_total>v_balance then raise exception 'Nilai retur melebihi saldo piutang pelanggan'; end if;
  v_after:=v_balance-v_total;

  update public.customer_returns set refund_method='ACCOUNT_CREDIT',refund_reference=null where id=v_return_id;
  update public.customer_refunds set method='ACCOUNT_CREDIT',reference=null where return_id=v_return_id;
  update public.sales set returned_credit_amount=returned_credit_amount+v_total,
    account_status=case when credit_amount-paid_credit_amount-(returned_credit_amount+v_total)<=0 then 'PAID' else 'PARTIAL' end
    where id=p_sale_id;
  insert into public.customer_account_entries(
    tenant_id,customer_id,entry_type,amount,balance_after,reference_type,reference_id,
    document_no,note,actor_id,idempotency_key
  ) values(
    p_tenant_id,v_sale.customer_id,'RETURN_CREDIT',-v_total,v_after,'CUSTOMER_RETURN',v_return_id,
    v_result->>'returnNo','Retur mengurangi piutang '||v_sale.receipt_no,p_actor_id,p_idempotency_key||':account-credit'
  );
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'CUSTOMER_CREDIT_RETURNED','customer_return',v_return_id,
    jsonb_build_object('saleId',p_sale_id,'customerId',v_sale.customer_id,'amount',v_total,
      'invoiceOutstandingBefore',v_outstanding,'customerBalanceAfter',v_after));
  return v_result||jsonb_build_object('refundMethod','ACCOUNT_CREDIT','accountBalanceAfter',v_after);
end $$;

create or replace function public.customer_credit_aging(
  p_tenant_id uuid,p_actor_id uuid,p_as_of date default current_date
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true)
    then raise exception 'Akun tidak aktif'; end if;
  with invoices as (
    select s.id,s.customer_id,s.receipt_no,s.due_on,s.occurred_at,
      greatest(s.credit_amount-s.paid_credit_amount-s.returned_credit_amount,0) outstanding,
      greatest(p_as_of-coalesce(s.due_on,p_as_of),0) age_days
    from public.sales s
    where s.tenant_id=p_tenant_id and s.credit_amount>s.paid_credit_amount+s.returned_credit_amount
      and s.account_status in ('OPEN','PARTIAL','OVERDUE')
  ), buckets as (
    select
      coalesce(sum(outstanding) filter(where due_on is null or due_on>=p_as_of),0) current_amount,
      coalesce(sum(outstanding) filter(where age_days between 1 and 30),0) days_1_30,
      coalesce(sum(outstanding) filter(where age_days between 31 and 60),0) days_31_60,
      coalesce(sum(outstanding) filter(where age_days>60),0) days_over_60,
      coalesce(sum(outstanding),0) total_amount,count(*) invoice_count
    from invoices
  )
  select jsonb_build_object(
    'asOf',p_as_of,'total',total_amount,'invoiceCount',invoice_count,
    'buckets',jsonb_build_object('current',current_amount,'days1To30',days_1_30,
      'days31To60',days_31_60,'daysOver60',days_over_60),
    'oldest',coalesce((select jsonb_agg(row_data order by row_data->>'dueOn')
      from (select jsonb_build_object('saleId',i.id,'customerId',i.customer_id,'receiptNo',i.receipt_no,
        'dueOn',i.due_on,'outstanding',i.outstanding,'ageDays',i.age_days) row_data
        from invoices i where i.due_on<p_as_of order by i.due_on limit 20) x),'[]'::jsonb)
  ) into v_result from buckets;
  return v_result;
end $$;

revoke all on function public.process_customer_return_v3(uuid,uuid,text,uuid,text,text,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.customer_credit_aging(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.process_customer_return_v3(uuid,uuid,text,uuid,text,text,text,uuid,jsonb) to service_role;
grant execute on function public.customer_credit_aging(uuid,uuid,date) to service_role;
