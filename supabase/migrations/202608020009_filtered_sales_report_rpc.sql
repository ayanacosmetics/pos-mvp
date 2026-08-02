-- Move filtered sales aggregation into Postgres so edge runtimes do not
-- download and repeatedly transform every receipt in the selected period.

create or replace function public.report_sales_filtered_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_outlet_ids uuid[],
  p_from date,
  p_to date,
  p_timezone text default 'Asia/Makassar',
  p_staff_id uuid default null,
  p_payment_state text default 'ALL',
  p_payment_methods text[] default array['CASH','QRIS','TRANSFER','EDC','CREDIT','MULTIPAYMENT'],
  p_include_credit_profit boolean default true,
  p_include_credit_revenue boolean default false
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_metrics jsonb;
  v_daily jsonb;
  v_staff jsonb;
  v_matched bigint;
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active=true
  ) then raise exception 'Akun laporan tidak aktif'; end if;
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then
    raise exception 'Periode laporan penjualan tidak valid';
  end if;
  if coalesce(array_length(p_outlet_ids,1),0)=0 then
    raise exception 'Pilih minimal satu outlet untuk laporan';
  end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then
    raise exception 'Zona waktu laporan tidak valid';
  end if;
  if p_payment_state not in ('ALL','PAID','CREDIT') then
    raise exception 'Status pembayaran laporan tidak valid';
  end if;

  v_start:=p_from::timestamp at time zone p_timezone;
  v_end:=(p_to+1)::timestamp at time zone p_timezone;

  create temporary table if not exists pg_temp.nusa_filtered_sales_report(
    sale_id uuid primary key,
    report_date date not null,
    cashier_id uuid,
    cashier_name text,
    status text not null,
    grand_total numeric not null,
    return_total numeric not null,
    net_total numeric not null,
    net_cost numeric not null,
    paid_ratio numeric not null,
    selected boolean not null
  ) on commit drop;
  truncate pg_temp.nusa_filtered_sales_report;

  insert into pg_temp.nusa_filtered_sales_report
  with payment_totals as (
    select payment.sale_id,
      count(*) payment_count,
      bool_or(upper(payment.method)='CREDIT') has_credit,
      coalesce(sum(payment.amount) filter(where upper(payment.method)<>'CREDIT'),0) non_credit_paid,
      case when count(*)>1 then 'MULTIPAYMENT'
        else max(case when upper(payment.method) in ('TUNAI','CASH') then 'CASH' else upper(payment.method) end)
      end payment_class
    from public.payments payment
    where payment.tenant_id=p_tenant_id
    group by payment.sale_id
  ), returned as (
    select return_doc.sale_id,
      coalesce(sum(return_doc.total),0) return_total,
      coalesce(sum(return_item.base_qty*return_item.unit_cost),0) return_cost
    from public.customer_returns return_doc
    left join public.customer_return_items return_item on return_item.return_id=return_doc.id
    where return_doc.tenant_id=p_tenant_id and return_doc.status='COMPLETED'
    group by return_doc.sale_id
  ), source as (
    select sale.id sale_id,(sale.occurred_at at time zone p_timezone)::date report_date,
      sale.cashier_id,coalesce(profile.display_name,'Kasir') cashier_name,sale.status,
      sale.grand_total,coalesce(returned.return_total,0) return_total,
      case when sale.status='VOIDED' then 0 else greatest(0,sale.grand_total-coalesce(returned.return_total,0)) end net_total,
      case when sale.status='VOIDED' then 0 else greatest(0,sale.cost_total-coalesce(returned.return_cost,0)) end net_cost,
      case when sale.grand_total>0 then least(1,greatest(0,
        (coalesce(payment.non_credit_paid,0)+coalesce(sale.paid_credit_amount,0))/sale.grand_total
      )) else 1 end paid_ratio,
      coalesce(payment.has_credit,false) has_credit,coalesce(payment.payment_class,'') payment_class
    from public.sales sale
    left join payment_totals payment on payment.sale_id=sale.id
    left join returned on returned.sale_id=sale.id
    left join public.profiles profile on profile.tenant_id=p_tenant_id and profile.user_id=sale.cashier_id
    where sale.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids)
      and sale.status in ('COMPLETED','VOIDED')
      and sale.occurred_at>=v_start and sale.occurred_at<v_end
  )
  select sale_id,report_date,cashier_id,cashier_name,status,grand_total,return_total,net_total,net_cost,paid_ratio,
    (coalesce(p_staff_id=source.cashier_id,true)
      and (p_payment_state='ALL' or p_payment_state='PAID' and not has_credit or p_payment_state='CREDIT' and has_credit)
      and payment_class=any(p_payment_methods)) selected
  from source;

  select jsonb_build_object(
    'netSales',coalesce(sum(case when p_include_credit_revenue then net_total else net_total*paid_ratio end) filter(where selected and status<>'VOIDED'),0),
    'grossProfit',coalesce(sum(case when p_include_credit_profit then net_total-net_cost else (net_total-net_cost)*paid_ratio end) filter(where selected and status<>'VOIDED'),0),
    'returnTotal',coalesce(sum(return_total) filter(where selected and status<>'VOIDED'),0),
    'transactionCount',count(*) filter(where selected and status<>'VOIDED'),
    'activityCount',count(*) filter(where selected),
    'voidedCount',count(*) filter(where selected and status='VOIDED'),
    'grossMarginPercent',case when coalesce(sum(case when p_include_credit_revenue then net_total else net_total*paid_ratio end) filter(where selected and status<>'VOIDED'),0)=0 then 0 else
      sum(case when p_include_credit_profit then net_total-net_cost else (net_total-net_cost)*paid_ratio end) filter(where selected and status<>'VOIDED')/
      sum(case when p_include_credit_revenue then net_total else net_total*paid_ratio end) filter(where selected and status<>'VOIDED')*100 end
  ) into v_metrics from pg_temp.nusa_filtered_sales_report;

  select coalesce(jsonb_agg(jsonb_build_object(
    'date',report_date,'grossSales',gross_sales,'returns',returns,'netSales',net_sales,
    'grossProfit',gross_profit,'transactionCount',transaction_count,'activityCount',activity_count,
    'voidedCount',voided_count,'returnCount',return_count
  ) order by report_date),'[]'::jsonb) into v_daily
  from (
    select report_date,
      coalesce(sum(grand_total) filter(where selected and status<>'VOIDED'),0) gross_sales,
      coalesce(sum(return_total) filter(where selected and status<>'VOIDED'),0) returns,
      coalesce(sum(case when p_include_credit_revenue then net_total else net_total*paid_ratio end) filter(where selected and status<>'VOIDED'),0) net_sales,
      coalesce(sum(case when p_include_credit_profit then net_total-net_cost else (net_total-net_cost)*paid_ratio end) filter(where selected and status<>'VOIDED'),0) gross_profit,
      count(*) filter(where selected and status<>'VOIDED') transaction_count,
      count(*) filter(where selected) activity_count,
      count(*) filter(where selected and status='VOIDED') voided_count,
      count(*) filter(where selected and status<>'VOIDED' and return_total>0) return_count
    from pg_temp.nusa_filtered_sales_report group by report_date
    having count(*) filter(where selected)>0
  ) daily;

  select coalesce(jsonb_agg(jsonb_build_object('id',cashier_id,'name',cashier_name) order by cashier_name),'[]'::jsonb)
    into v_staff from (
      select distinct cashier_id,cashier_name from pg_temp.nusa_filtered_sales_report where cashier_id is not null
    ) staff;
  select count(*) into v_matched from pg_temp.nusa_filtered_sales_report where selected;

  return jsonb_build_object('metrics',v_metrics,'daily',v_daily,'staff',v_staff,'matchedSales',v_matched);
end $$;

revoke all on function public.report_sales_filtered_v1(uuid,uuid,uuid[],date,date,text,uuid,text,text[],boolean,boolean)
  from public,anon,authenticated;
grant execute on function public.report_sales_filtered_v1(uuid,uuid,uuid[],date,date,text,uuid,text,text[],boolean,boolean)
  to service_role;
