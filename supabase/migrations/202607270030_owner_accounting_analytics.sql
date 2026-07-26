-- Kasir Nusa POS v1.26 - owner accounting, outlet expenses, cash flow, aging, and product health

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check(length(trim(name)) between 2 and 80),
  cash_flow_group text not null default 'OPERATING'
    check(cash_flow_group in ('OPERATING','INVESTING','FINANCING')),
  active boolean not null default true,
  created_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,name)
);

create table if not exists public.outlet_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id),
  category_id uuid not null references public.expense_categories(id),
  expense_no text not null,
  idempotency_key text not null,
  occurred_on date not null,
  amount numeric(19,4) not null check(amount>0),
  payment_method text not null check(payment_method in ('CASH','TRANSFER','QRIS','EDC','OTHER')),
  reference text,
  shift_id uuid references public.shifts(id),
  vendor_name text,
  note text not null check(length(trim(note))>=3),
  status text not null default 'POSTED' check(status in ('POSTED','VOIDED')),
  created_by uuid not null references public.profiles(user_id),
  voided_by uuid references public.profiles(user_id),
  void_reason text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  unique(tenant_id,expense_no),
  unique(tenant_id,idempotency_key)
);
alter table public.outlet_expenses add column if not exists shift_id uuid references public.shifts(id);
create index if not exists outlet_expenses_report_idx
  on public.outlet_expenses(tenant_id,outlet_id,occurred_on desc) where status='POSTED';

alter table public.expense_categories enable row level security;
alter table public.outlet_expenses enable row level security;
drop policy if exists expense_categories_owner_read on public.expense_categories;
create policy expense_categories_owner_read on public.expense_categories for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');
drop policy if exists outlet_expenses_owner_read on public.outlet_expenses;
create policy outlet_expenses_owner_read on public.outlet_expenses for select to authenticated
  using(tenant_id=public.current_tenant_id() and public.current_app_role()='OWNER');

insert into public.expense_categories(tenant_id,name,cash_flow_group)
select tenant.id,defaults.name,defaults.cash_flow_group
from public.tenants tenant cross join (values
  ('Gaji dan tunjangan','OPERATING'),
  ('Sewa tempat','OPERATING'),
  ('Listrik, air, dan internet','OPERATING'),
  ('Perlengkapan toko','OPERATING'),
  ('Pemasaran','OPERATING'),
  ('Perawatan dan perbaikan','OPERATING'),
  ('Pajak dan administrasi','OPERATING'),
  ('Pembelian aset','INVESTING'),
  ('Modal dan pembiayaan','FINANCING')
) defaults(name,cash_flow_group)
on conflict(tenant_id,name) do nothing;

create or replace function public.record_outlet_expense(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_category_id uuid,p_occurred_on date,p_amount numeric,p_payment_method text,
  p_reference text,p_vendor_name text,p_note text,p_shift_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing public.outlet_expenses%rowtype;v_seq bigint;v_no text;
  v_method text:=upper(trim(coalesce(p_payment_method,'')));v_expense public.outlet_expenses%rowtype;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat mencatat biaya';end if;
  select * into v_existing from outlet_expenses where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'expenseNo',v_existing.expense_no,'duplicate',true);end if;
  if not exists(select 1 from outlets where id=p_outlet_id and tenant_id=p_tenant_id and active)
    then raise exception 'Outlet biaya tidak valid';end if;
  if not exists(select 1 from expense_categories where id=p_category_id and tenant_id=p_tenant_id and active)
    then raise exception 'Kategori biaya tidak valid';end if;
  if p_occurred_on is null or p_occurred_on>current_date+1 then raise exception 'Tanggal biaya tidak valid';end if;
  if coalesce(p_amount,0)<=0 then raise exception 'Nominal biaya harus lebih dari nol';end if;
  if v_method not in ('CASH','TRANSFER','QRIS','EDC','OTHER') then raise exception 'Metode pembayaran tidak valid';end if;
  if v_method<>'CASH' and nullif(trim(coalesce(p_reference,'')),'') is null
    then raise exception 'Referensi pembayaran non-tunai wajib diisi';end if;
  if p_shift_id is not null and (v_method<>'CASH' or not exists(
    select 1 from shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id
      and cashier_id=p_actor_id and status='OPEN'
  )) then raise exception 'Shift tunai aktif milik Owner tidak valid';end if;
  if length(trim(coalesce(p_note,'')))<3 then raise exception 'Keterangan biaya minimal 3 karakter';end if;
  insert into document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'EXPENSE',2)
    on conflict(tenant_id,kind) do update set next_value=document_sequences.next_value+1
    returning next_value-1 into v_seq;
  v_no:='BYA-'||to_char(p_occurred_on,'YYMM')||'-'||lpad(v_seq::text,5,'0');
  insert into outlet_expenses(
    tenant_id,outlet_id,category_id,expense_no,idempotency_key,occurred_on,amount,
    payment_method,reference,shift_id,vendor_name,note,created_by
  ) values(
    p_tenant_id,p_outlet_id,p_category_id,v_no,p_idempotency_key,p_occurred_on,p_amount,
    v_method,nullif(trim(coalesce(p_reference,'')),''),p_shift_id,nullif(trim(coalesce(p_vendor_name,'')),''),
    trim(p_note),p_actor_id
  ) returning * into v_expense;
  if p_shift_id is not null then
    insert into cash_movements(tenant_id,shift_id,movement_type,amount,note,actor_id,reference_type,reference_id)
      values(p_tenant_id,p_shift_id,'CASH_OUT',p_amount,'Biaya outlet '||v_no,p_actor_id,'OUTLET_EXPENSE',v_expense.id);
  end if;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OUTLET_EXPENSE_RECORDED','outlet_expense',v_expense.id,
      jsonb_build_object('expenseNo',v_no,'outletId',p_outlet_id,'categoryId',p_category_id,
        'amount',p_amount,'paymentMethod',v_method));
  return jsonb_build_object('id',v_expense.id,'expenseNo',v_no,'amount',p_amount,'duplicate',false);
end $$;

create or replace function public.void_outlet_expense(
  p_tenant_id uuid,p_actor_id uuid,p_expense_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_expense public.outlet_expenses%rowtype;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat membatalkan biaya';end if;
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Alasan pembatalan minimal 5 karakter';end if;
  select * into v_expense from outlet_expenses where id=p_expense_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Biaya tidak ditemukan';end if;
  if v_expense.status<>'POSTED' then raise exception 'Biaya sudah dibatalkan';end if;
  update outlet_expenses set status='VOIDED',voided_by=p_actor_id,void_reason=trim(p_reason),voided_at=now()
    where id=p_expense_id returning * into v_expense;
  if v_expense.shift_id is not null and exists(select 1 from shifts where id=v_expense.shift_id and status='OPEN') then
    insert into cash_movements(tenant_id,shift_id,movement_type,amount,note,actor_id,reference_type,reference_id)
      values(p_tenant_id,v_expense.shift_id,'CASH_IN',v_expense.amount,'Pembatalan biaya '||v_expense.expense_no,
        p_actor_id,'OUTLET_EXPENSE_VOID',v_expense.id);
  end if;
  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OUTLET_EXPENSE_VOIDED','outlet_expense',v_expense.id,
      jsonb_build_object('expenseNo',v_expense.expense_no,'amount',v_expense.amount,'reason',trim(p_reason)));
  return jsonb_build_object('id',v_expense.id,'expenseNo',v_expense.expense_no,'status',v_expense.status);
end $$;

create or replace function public.report_owner_finance(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_ids uuid[],p_from date,p_to date,
  p_timezone text default 'Asia/Makassar'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_start timestamptz;v_end timestamptz;v_metrics jsonb;v_daily jsonb;v_expenses jsonb;
  v_expense_breakdown jsonb;v_cash_flow jsonb;v_aging jsonb;v_supplier_actions jsonb;
  v_customer_actions jsonb;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat melihat laporan keuangan';end if;
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then raise exception 'Periode laporan tidak valid';end if;
  if coalesce(array_length(p_outlet_ids,1),0)=0 then raise exception 'Pilih minimal satu outlet';end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Zona waktu tidak valid';end if;
  if exists(select 1 from unnest(p_outlet_ids) selected(outlet_id)
    left join outlets on outlets.id=selected.outlet_id and outlets.tenant_id=p_tenant_id and outlets.active where outlets.id is null)
    then raise exception 'Outlet laporan tidak valid';end if;
  v_start:=p_from::timestamp at time zone p_timezone;v_end:=(p_to+1)::timestamp at time zone p_timezone;

  with sale_totals as (
    select coalesce(sum(grand_total),0) sales,coalesce(sum(cost_total),0) cost
    from sales where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED'
      and occurred_at>=v_start and occurred_at<v_end
  ), return_totals as (
    select coalesce(sum(items.line_total),0) returns,coalesce(sum(items.base_qty*items.unit_cost),0) returned_cost
    from customer_returns docs join sales sale on sale.id=docs.sale_id and sale.outlet_id=any(p_outlet_ids)
    join customer_return_items items on items.return_id=docs.id
    where docs.tenant_id=p_tenant_id and docs.status='COMPLETED' and docs.occurred_at>=v_start and docs.occurred_at<v_end
  ), expense_totals as (
    select coalesce(sum(expense.amount),0) expenses from outlet_expenses expense
    join expense_categories category on category.id=expense.category_id and category.cash_flow_group='OPERATING'
    where expense.tenant_id=p_tenant_id and expense.outlet_id=any(p_outlet_ids) and expense.status='POSTED'
      and expense.occurred_on between p_from and p_to
  ), receivables as (
    select coalesce(sum(greatest(credit_amount-paid_credit_amount,0)),0) balance
    from sales where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED' and credit_amount>paid_credit_amount
  ), payables as (
    select coalesce(sum(greatest(bill.original_amount-bill.return_credit_amount-bill.paid_amount,0)),0) balance
    from supplier_bills bill join purchase_receipts receipt on receipt.id=bill.receipt_id
    join stock_locations location on location.id=receipt.location_id and location.outlet_id=any(p_outlet_ids)
    where bill.tenant_id=p_tenant_id
  )
  select jsonb_build_object(
    'netSales',sales.sales-returns.returns,
    'costOfGoods',sales.cost-returns.returned_cost,
    'grossProfit',(sales.sales-returns.returns)-(sales.cost-returns.returned_cost),
    'operatingExpenses',expenses.expenses,
    'operatingProfit',(sales.sales-returns.returns)-(sales.cost-returns.returned_cost)-expenses.expenses,
    'operatingMarginPercent',case when sales.sales-returns.returns=0 then 0 else round(
      (((sales.sales-returns.returns)-(sales.cost-returns.returned_cost)-expenses.expenses)/(sales.sales-returns.returns))*100,2) end,
    'receivables',receivables.balance,'payables',payables.balance
  ) into v_metrics from sale_totals sales cross join return_totals returns cross join expense_totals expenses
    cross join receivables cross join payables;

  with days as (select generate_series(p_from,p_to,interval '1 day')::date report_date),
  sale_day as (
    select (occurred_at at time zone p_timezone)::date report_date,sum(grand_total) sales,sum(cost_total) cost
    from sales where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED'
      and occurred_at>=v_start and occurred_at<v_end group by 1
  ), return_day as (
    select (docs.occurred_at at time zone p_timezone)::date report_date,sum(items.line_total) returns,
      sum(items.base_qty*items.unit_cost) returned_cost
    from customer_returns docs join sales sale on sale.id=docs.sale_id and sale.outlet_id=any(p_outlet_ids)
    join customer_return_items items on items.return_id=docs.id
    where docs.tenant_id=p_tenant_id and docs.status='COMPLETED' and docs.occurred_at>=v_start and docs.occurred_at<v_end group by 1
  ), expense_day as (
    select expense.occurred_on report_date,sum(expense.amount) expenses from outlet_expenses expense
    join expense_categories category on category.id=expense.category_id and category.cash_flow_group='OPERATING'
    where expense.tenant_id=p_tenant_id and expense.outlet_id=any(p_outlet_ids) and expense.status='POSTED'
      and expense.occurred_on between p_from and p_to group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',days.report_date,'netSales',coalesce(sales.sales,0)-coalesce(returns.returns,0),
    'grossProfit',(coalesce(sales.sales,0)-coalesce(returns.returns,0))-
      (coalesce(sales.cost,0)-coalesce(returns.returned_cost,0)),
    'expenses',coalesce(expenses.expenses,0),
    'operatingProfit',(coalesce(sales.sales,0)-coalesce(returns.returns,0))-
      (coalesce(sales.cost,0)-coalesce(returns.returned_cost,0))-coalesce(expenses.expenses,0)
  ) order by days.report_date),'[]'::jsonb) into v_daily
  from days left join sale_day sales using(report_date) left join return_day returns using(report_date)
    left join expense_day expenses using(report_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',expense.id,'expenseNo',expense.expense_no,'occurredOn',expense.occurred_on,
    'outletId',expense.outlet_id,'outletName',outlet.name,'categoryId',expense.category_id,
    'categoryName',category.name,'cashFlowGroup',category.cash_flow_group,'amount',expense.amount,
    'paymentMethod',expense.payment_method,'reference',expense.reference,'vendorName',expense.vendor_name,
    'note',expense.note,'status',expense.status
  ) order by expense.occurred_on desc,expense.created_at desc),'[]'::jsonb) into v_expenses
  from (select * from outlet_expenses where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids)
    and occurred_on between p_from and p_to order by occurred_on desc,created_at desc limit 200) expense
  join outlets outlet on outlet.id=expense.outlet_id join expense_categories category on category.id=expense.category_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'categoryId',category.id,'categoryName',category.name,'cashFlowGroup',category.cash_flow_group,
    'amount',coalesce(total.amount,0)
  ) order by coalesce(total.amount,0) desc,category.name),'[]'::jsonb) into v_expense_breakdown
  from expense_categories category left join (
    select category_id,sum(amount) amount from outlet_expenses
    where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='POSTED'
      and occurred_on between p_from and p_to group by category_id
  ) total on total.category_id=category.id where category.tenant_id=p_tenant_id and category.active;

  with cash_events as (
    select upper(payment.method) method,payment.amount inflow,0::numeric outflow
    from payments payment join sales sale on sale.id=payment.sale_id
    where payment.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and sale.status='COMPLETED'
      and upper(payment.method)<>'CREDIT' and payment.created_at>=v_start and payment.created_at<v_end
    union all select upper(method),amount,0 from customer_payment_receipts
      where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and occurred_at>=v_start and occurred_at<v_end
    union all select upper(method),0,amount from supplier_payment_receipts
      where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and occurred_at>=v_start and occurred_at<v_end
    union all select upper(refund.method),0,refund.amount from customer_refunds refund
      join customer_returns docs on docs.id=refund.return_id join sales sale on sale.id=docs.sale_id
      where refund.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and refund.status='COMPLETED'
        and refund.occurred_at>=v_start and refund.occurred_at<v_end
    union all select upper(payment_method),0,amount from outlet_expenses
      where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='POSTED' and occurred_on between p_from and p_to
  ), grouped as (
    select method,sum(inflow) inflow,sum(outflow) outflow from cash_events group by method
  )
  select jsonb_build_object(
    'totalInflow',coalesce(sum(inflow),0),'totalOutflow',coalesce(sum(outflow),0),
    'netCashFlow',coalesce(sum(inflow-outflow),0),
    'methods',coalesce(jsonb_agg(jsonb_build_object('method',method,'inflow',inflow,'outflow',outflow,'net',inflow-outflow)
      order by method),'[]'::jsonb)
  ) into v_cash_flow from grouped;

  with customer_open as (
    select greatest(credit_amount-paid_credit_amount,0) amount,due_on from sales
    where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED' and credit_amount>paid_credit_amount
  ), supplier_open as (
    select greatest(bill.original_amount-bill.return_credit_amount-bill.paid_amount,0) amount,bill.due_on
    from supplier_bills bill join purchase_receipts receipt on receipt.id=bill.receipt_id
    join stock_locations location on location.id=receipt.location_id and location.outlet_id=any(p_outlet_ids)
    where bill.tenant_id=p_tenant_id and bill.original_amount>bill.return_credit_amount+bill.paid_amount
  )
  select jsonb_build_object(
    'receivables',jsonb_build_object(
      'current',coalesce((select sum(amount) from customer_open where due_on is null or due_on>=p_to),0),
      'days1To30',coalesce((select sum(amount) from customer_open where p_to-due_on between 1 and 30),0),
      'days31To60',coalesce((select sum(amount) from customer_open where p_to-due_on between 31 and 60),0),
      'daysOver60',coalesce((select sum(amount) from customer_open where p_to-due_on>60),0),
      'dueNext30',coalesce((select sum(amount) from customer_open where due_on>p_to and due_on<=p_to+30),0)),
    'payables',jsonb_build_object(
      'current',coalesce((select sum(amount) from supplier_open where due_on is null or due_on>=p_to),0),
      'days1To30',coalesce((select sum(amount) from supplier_open where p_to-due_on between 1 and 30),0),
      'days31To60',coalesce((select sum(amount) from supplier_open where p_to-due_on between 31 and 60),0),
      'daysOver60',coalesce((select sum(amount) from supplier_open where p_to-due_on>60),0),
      'dueNext30',coalesce((select sum(amount) from supplier_open where due_on>p_to and due_on<=p_to+30),0))
  ) into v_aging;

  select coalesce(jsonb_agg(jsonb_build_object(
    'billId',bill.id,'supplierId',bill.supplier_id,'supplierName',supplier.name,
    'documentNo',bill.document_no,'dueOn',bill.due_on,
    'outstanding',greatest(bill.original_amount-bill.return_credit_amount-bill.paid_amount,0),
    'daysOverdue',greatest(p_to-coalesce(bill.due_on,p_to),0)
  ) order by bill.due_on nulls last,bill.occurred_at),'[]'::jsonb) into v_supplier_actions
  from supplier_bills bill join suppliers supplier on supplier.id=bill.supplier_id
  join purchase_receipts receipt on receipt.id=bill.receipt_id
  join stock_locations location on location.id=receipt.location_id and location.outlet_id=any(p_outlet_ids)
  where bill.tenant_id=p_tenant_id and bill.original_amount>bill.return_credit_amount+bill.paid_amount;

  select coalesce(jsonb_agg(jsonb_build_object(
    'saleId',sale.id,'customerId',sale.customer_id,'customerName',customer.name,
    'receiptNo',sale.receipt_no,'dueOn',sale.due_on,
    'outstanding',greatest(sale.credit_amount-sale.paid_credit_amount,0),
    'daysOverdue',greatest(p_to-coalesce(sale.due_on,p_to),0)
  ) order by sale.due_on nulls last,sale.occurred_at),'[]'::jsonb) into v_customer_actions
  from sales sale join customers customer on customer.id=sale.customer_id
  where sale.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and sale.status='COMPLETED'
    and sale.credit_amount>sale.paid_credit_amount;

  return jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to,'timezone',p_timezone),
    'metrics',v_metrics,'daily',v_daily,'expenses',v_expenses,'expenseBreakdown',v_expense_breakdown,
    'cashFlow',v_cash_flow,'aging',v_aging,'supplierActions',v_supplier_actions,
    'customerActions',v_customer_actions,'generatedAt',now()
  );
end $$;

create or replace function public.owner_product_analytics(
  p_tenant_id uuid,p_actor_id uuid,p_outlet_ids uuid[],p_from date,p_to date,p_timezone text default 'Asia/Makassar'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_start timestamptz;v_end timestamptz;v_products jsonb;
begin
  if not exists(select 1 from profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active and role='OWNER')
    then raise exception 'Hanya Owner yang dapat melihat analitik produk';end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Periode analitik tidak valid';end if;
  v_start:=p_from::timestamp at time zone p_timezone;v_end:=(p_to+1)::timestamp at time zone p_timezone;
  with inventory as (
    select balance.product_id,sum(balance.quantity) stock_qty,sum(balance.quantity*balance.avg_cost) stock_value
    from stock_balances balance join stock_locations location on location.id=balance.location_id
    where balance.tenant_id=p_tenant_id and location.outlet_id=any(p_outlet_ids) group by balance.product_id
  ), events as (
    select item.product_id,item.base_qty net_qty,item.total net_revenue,item.cost_total net_cost
    from sale_items item join sales sale on sale.id=item.sale_id
    where item.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and sale.status='COMPLETED'
      and sale.occurred_at>=v_start and sale.occurred_at<v_end
    union all
    select item.product_id,-item.base_qty,-item.line_total,-(item.base_qty*item.unit_cost)
    from customer_return_items item join customer_returns docs on docs.id=item.return_id
    join sales sale on sale.id=docs.sale_id
    where item.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and docs.status='COMPLETED'
      and docs.occurred_at>=v_start and docs.occurred_at<v_end
  ), sales_metrics as (
    select product_id,sum(net_qty) net_qty,sum(net_revenue) net_revenue,sum(net_cost) net_cost
    from events group by product_id
  ), last_sales as (
    select item.product_id,max(sale.occurred_at at time zone p_timezone)::date last_sale_on
    from sale_items item join sales sale on sale.id=item.sale_id
    where item.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and sale.status='COMPLETED'
    group by item.product_id
  ), metrics as (
    select product.id,product.sku,product.name,product.category,product.brand,
      coalesce(inventory.stock_qty,0) stock_qty,coalesce(inventory.stock_value,0) stock_value,
      coalesce(sales.net_qty,0) net_qty,coalesce(sales.net_revenue,0) net_revenue,
      coalesce(sales.net_revenue-sales.net_cost,0) gross_profit,last_sales.last_sale_on,
      case when coalesce(sales.net_revenue,0)=0 then 0 else round(
        ((sales.net_revenue-sales.net_cost)/sales.net_revenue)*100,2) end margin_percent
    from products product left join inventory on inventory.product_id=product.id
    left join sales_metrics sales on sales.product_id=product.id left join last_sales on last_sales.product_id=product.id
    where product.tenant_id=p_tenant_id and product.active
  ), ranked as (
    select metrics.*,ntile(5) over(order by net_qty desc,name) velocity_rank from metrics
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId',id,'sku',sku,'productName',name,'category',category,'brand',brand,
    'stockQty',stock_qty,'stockValue',stock_value,'netQty',net_qty,'netRevenue',net_revenue,
    'grossProfit',gross_profit,'marginPercent',margin_percent,'lastSaleOn',last_sale_on,
    'fastMoving',(net_qty>0 and velocity_rank=1),
    'slowMoving',(stock_qty>0 and (net_qty<=0 or last_sale_on is null or last_sale_on<p_to-30)),
    'lowMargin',(net_revenue>0 and margin_percent<15),
    'deadStock',(stock_qty>0 and (last_sale_on is null or last_sale_on<p_to-90))
  ) order by
    (stock_qty>0 and (last_sale_on is null or last_sale_on<p_to-90)) desc,
    (net_revenue>0 and margin_percent<15) desc,stock_value desc,name),'[]'::jsonb) into v_products
  from ranked where stock_qty<>0 or net_qty<>0 or net_revenue<>0;
  return jsonb_build_object('products',v_products,'generatedAt',now());
end $$;

revoke all on function public.record_outlet_expense(uuid,uuid,text,uuid,uuid,date,numeric,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.void_outlet_expense(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.report_owner_finance(uuid,uuid,uuid[],date,date,text) from public,anon,authenticated;
revoke all on function public.owner_product_analytics(uuid,uuid,uuid[],date,date,text) from public,anon,authenticated;
grant execute on function public.record_outlet_expense(uuid,uuid,text,uuid,uuid,date,numeric,text,text,text,text,uuid) to service_role;
grant execute on function public.void_outlet_expense(uuid,uuid,uuid,text) to service_role;
grant execute on function public.report_owner_finance(uuid,uuid,uuid[],date,date,text) to service_role;
grant execute on function public.owner_product_analytics(uuid,uuid,uuid[],date,date,text) to service_role;
grant select,insert,update on public.expense_categories,public.outlet_expenses to service_role;
