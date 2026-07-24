-- Kasir Nusa POS - operational reporting foundation with return-aware net sales

create index if not exists sales_reporting_lookup
  on public.sales(tenant_id,outlet_id,occurred_at desc) where status='COMPLETED';
create index if not exists customer_returns_reporting_lookup
  on public.customer_returns(tenant_id,occurred_at desc,sale_id) where status='COMPLETED';
create index if not exists purchase_receipts_reporting_lookup
  on public.purchase_receipts(tenant_id,occurred_at desc,location_id) where status='RECEIVED';

create or replace function public.report_operational_summary(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_outlet_ids uuid[],
  p_from date,
  p_to date,
  p_timezone text default 'Asia/Makassar'
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor public.profiles%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_metrics jsonb;
  v_daily jsonb;
  v_products jsonb;
  v_outlets jsonb;
  v_recent jsonb;
  v_suppliers jsonb;
begin
  select * into v_actor from public.profiles
  where user_id=p_actor_id and tenant_id=p_tenant_id and active=true;
  if not found or v_actor.role not in ('OWNER','ADMIN') then
    raise exception 'Akun tidak memiliki hak melihat laporan';
  end if;
  if p_from is null or p_to is null or p_from>p_to then
    raise exception 'Periode laporan tidak valid';
  end if;
  if p_to-p_from>366 then
    raise exception 'Periode laporan maksimal 366 hari';
  end if;
  if coalesce(array_length(p_outlet_ids,1),0)=0 then
    raise exception 'Pilih minimal satu outlet untuk laporan';
  end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then
    raise exception 'Zona waktu laporan tidak valid';
  end if;
  if exists(
    select 1 from unnest(p_outlet_ids) selected(outlet_id)
    left join public.outlets outlet on outlet.id=selected.outlet_id and outlet.tenant_id=p_tenant_id and outlet.active=true
    where outlet.id is null
  ) then raise exception 'Outlet laporan tidak valid'; end if;
  if v_actor.role<>'OWNER' and exists(
    select 1 from unnest(p_outlet_ids) selected(outlet_id)
    where not exists(
      select 1 from public.user_outlets assignment
      where assignment.tenant_id=p_tenant_id and assignment.user_id=p_actor_id and assignment.outlet_id=selected.outlet_id
    )
  ) then raise exception 'Akun tidak memiliki akses ke salah satu outlet laporan'; end if;

  v_start:=p_from::timestamp at time zone p_timezone;
  v_end:=(p_to+1)::timestamp at time zone p_timezone;

  with sale_totals as (
    select count(*) transaction_count,
      coalesce(sum(s.grand_total),0) gross_sales,
      coalesce(sum(s.discount_total),0) discounts,
      coalesce(sum(s.cost_total),0) sale_cost,
      coalesce(sum(items.units),0) sale_units
    from public.sales s
    left join lateral (
      select coalesce(sum(si.base_qty),0) units from public.sale_items si where si.sale_id=s.id
    ) items on true
    where s.tenant_id=p_tenant_id and s.outlet_id=any(p_outlet_ids) and s.status='COMPLETED'
      and s.occurred_at>=v_start and s.occurred_at<v_end
  ), return_totals as (
    select count(distinct r.id) return_count,
      coalesce(sum(ri.line_total),0) return_total,
      coalesce(sum(ri.base_qty*ri.unit_cost),0) return_cost,
      coalesce(sum(ri.base_qty),0) return_units
    from public.customer_returns r
    join public.sales s on s.id=r.sale_id and s.tenant_id=p_tenant_id and s.outlet_id=any(p_outlet_ids)
    left join public.customer_return_items ri on ri.return_id=r.id
    where r.tenant_id=p_tenant_id and r.status='COMPLETED'
      and r.occurred_at>=v_start and r.occurred_at<v_end
  ), purchase_totals as (
    select coalesce(sum(item.base_qty*item.unit_cost),0) purchase_value
    from public.purchase_receipts receipt
    join public.stock_locations location on location.id=receipt.location_id and location.outlet_id=any(p_outlet_ids)
    join public.purchase_receipt_items item on item.receipt_id=receipt.id
    where receipt.tenant_id=p_tenant_id and receipt.status='RECEIVED'
      and receipt.occurred_at>=v_start and receipt.occurred_at<v_end
  ), inventory_totals as (
    select coalesce(sum(balance.quantity),0) inventory_units,
      coalesce(sum(balance.quantity*balance.avg_cost),0) inventory_value
    from public.stock_balances balance
    join public.stock_locations location on location.id=balance.location_id and location.outlet_id=any(p_outlet_ids)
    where balance.tenant_id=p_tenant_id
  )
  select jsonb_build_object(
    'grossSales',sale.gross_sales,
    'returnTotal',returns.return_total,
    'netSales',sale.gross_sales-returns.return_total,
    'discounts',sale.discounts,
    'costOfGoods',sale.sale_cost-returns.return_cost,
    'grossProfit',(sale.gross_sales-returns.return_total)-(sale.sale_cost-returns.return_cost),
    'grossMarginPercent',case when sale.gross_sales-returns.return_total=0 then 0 else
      round((((sale.gross_sales-returns.return_total)-(sale.sale_cost-returns.return_cost))/(sale.gross_sales-returns.return_total))*100,2) end,
    'transactionCount',sale.transaction_count,
    'returnCount',returns.return_count,
    'netUnits',sale.sale_units-returns.return_units,
    'purchaseValue',purchase.purchase_value,
    'inventoryUnits',inventory.inventory_units,
    'inventoryValue',inventory.inventory_value
  ) into v_metrics
  from sale_totals sale cross join return_totals returns cross join purchase_totals purchase cross join inventory_totals inventory;

  with days as (
    select generate_series(p_from,p_to,interval '1 day')::date report_date
  ), sales_daily as (
    select (s.occurred_at at time zone p_timezone)::date report_date,
      sum(s.grand_total) gross_sales,sum(s.cost_total) sale_cost,count(*) transaction_count
    from public.sales s
    where s.tenant_id=p_tenant_id and s.outlet_id=any(p_outlet_ids) and s.status='COMPLETED'
      and s.occurred_at>=v_start and s.occurred_at<v_end
    group by 1
  ), returns_daily as (
    select (r.occurred_at at time zone p_timezone)::date report_date,
      sum(ri.line_total) return_total,sum(ri.base_qty*ri.unit_cost) return_cost,count(distinct r.id) return_count
    from public.customer_returns r
    join public.sales s on s.id=r.sale_id and s.tenant_id=p_tenant_id and s.outlet_id=any(p_outlet_ids)
    join public.customer_return_items ri on ri.return_id=r.id
    where r.tenant_id=p_tenant_id and r.status='COMPLETED'
      and r.occurred_at>=v_start and r.occurred_at<v_end
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',days.report_date,
    'grossSales',coalesce(sales.gross_sales,0),
    'returns',coalesce(returns.return_total,0),
    'netSales',coalesce(sales.gross_sales,0)-coalesce(returns.return_total,0),
    'grossProfit',(coalesce(sales.gross_sales,0)-coalesce(returns.return_total,0))-
      (coalesce(sales.sale_cost,0)-coalesce(returns.return_cost,0)),
    'transactionCount',coalesce(sales.transaction_count,0),
    'returnCount',coalesce(returns.return_count,0)
  ) order by days.report_date),'[]'::jsonb) into v_daily
  from days left join sales_daily sales using(report_date) left join returns_daily returns using(report_date);

  with product_events as (
    select item.product_id,item.product_name,item.base_qty net_qty,item.total net_revenue,
      item.total-item.cost_total gross_profit
    from public.sale_items item
    join public.sales sale on sale.id=item.sale_id
    where sale.tenant_id=p_tenant_id and sale.outlet_id=any(p_outlet_ids) and sale.status='COMPLETED'
      and sale.occurred_at>=v_start and sale.occurred_at<v_end
    union all
    select item.product_id,product.name,-item.base_qty,-item.line_total,
      -(item.line_total-(item.base_qty*item.unit_cost))
    from public.customer_return_items item
    join public.customer_returns return_doc on return_doc.id=item.return_id and return_doc.status='COMPLETED'
    join public.sales sale on sale.id=return_doc.sale_id and sale.outlet_id=any(p_outlet_ids)
    join public.products product on product.id=item.product_id
    where return_doc.tenant_id=p_tenant_id and return_doc.occurred_at>=v_start and return_doc.occurred_at<v_end
  ), grouped as (
    select product_id,max(product_name) product_name,sum(net_qty) net_qty,
      sum(net_revenue) net_revenue,sum(gross_profit) gross_profit
    from product_events group by product_id
    having sum(net_qty)<>0 or sum(net_revenue)<>0 or sum(gross_profit)<>0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId',product_id,'productName',product_name,'netQty',net_qty,
    'netRevenue',net_revenue,'grossProfit',gross_profit
  ) order by net_revenue desc,product_name) filter(where ranking<=20),'[]'::jsonb) into v_products
  from (select grouped.*,row_number() over(order by net_revenue desc,product_name) ranking from grouped) ranked;

  with sales_by_outlet as (
    select outlet_id,count(*) transaction_count,sum(grand_total) gross_sales,sum(cost_total) sale_cost
    from public.sales where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED'
      and occurred_at>=v_start and occurred_at<v_end group by outlet_id
  ), returns_by_outlet as (
    select sale.outlet_id,count(distinct return_doc.id) return_count,sum(item.line_total) return_total,
      sum(item.base_qty*item.unit_cost) return_cost
    from public.customer_returns return_doc
    join public.sales sale on sale.id=return_doc.sale_id and sale.outlet_id=any(p_outlet_ids)
    join public.customer_return_items item on item.return_id=return_doc.id
    where return_doc.tenant_id=p_tenant_id and return_doc.status='COMPLETED'
      and return_doc.occurred_at>=v_start and return_doc.occurred_at<v_end
    group by sale.outlet_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'outletId',outlet.id,'outletName',outlet.name,
    'transactionCount',coalesce(sales.transaction_count,0),'returnCount',coalesce(returns.return_count,0),
    'grossSales',coalesce(sales.gross_sales,0),'returnTotal',coalesce(returns.return_total,0),
    'netSales',coalesce(sales.gross_sales,0)-coalesce(returns.return_total,0),
    'grossProfit',(coalesce(sales.gross_sales,0)-coalesce(returns.return_total,0))-
      (coalesce(sales.sale_cost,0)-coalesce(returns.return_cost,0))
  ) order by outlet.name),'[]'::jsonb) into v_outlets
  from public.outlets outlet
  left join sales_by_outlet sales on sales.outlet_id=outlet.id
  left join returns_by_outlet returns on returns.outlet_id=outlet.id
  where outlet.tenant_id=p_tenant_id and outlet.id=any(p_outlet_ids);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',sale.id,'receiptNo',sale.receipt_no,'cashierName',profile.display_name,
    'paymentMethod',sale.payment_method,'grossTotal',sale.grand_total,
    'returnTotal',coalesce(returned.total,0),'netTotal',sale.grand_total-coalesce(returned.total,0),
    'occurredAt',sale.occurred_at
  ) order by sale.occurred_at desc),'[]'::jsonb) into v_recent
  from (select * from public.sales where tenant_id=p_tenant_id and outlet_id=any(p_outlet_ids) and status='COMPLETED'
    and occurred_at>=v_start and occurred_at<v_end order by occurred_at desc limit 20) sale
  join public.profiles profile on profile.user_id=sale.cashier_id
  left join lateral (
    select sum(total) total from public.customer_returns
    where sale_id=sale.id and status='COMPLETED'
  ) returned on true;

  with supplier_totals as (
    select receipt.supplier_id,receipt.supplier_name,count(distinct receipt.id) receipt_count,
      sum(item.base_qty) units,sum(item.base_qty*item.unit_cost) purchase_value
    from public.purchase_receipts receipt
    join public.stock_locations location on location.id=receipt.location_id and location.outlet_id=any(p_outlet_ids)
    join public.purchase_receipt_items item on item.receipt_id=receipt.id
    where receipt.tenant_id=p_tenant_id and receipt.status='RECEIVED'
      and receipt.occurred_at>=v_start and receipt.occurred_at<v_end
    group by receipt.supplier_id,receipt.supplier_name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplierId',supplier_id,'supplierName',supplier_name,'receiptCount',receipt_count,
    'units',units,'purchaseValue',purchase_value
  ) order by purchase_value desc),'[]'::jsonb) into v_suppliers from supplier_totals;

  return jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to,'timezone',p_timezone),
    'metrics',v_metrics,'daily',v_daily,'products',v_products,'outlets',v_outlets,
    'recentSales',v_recent,'suppliers',v_suppliers,'generatedAt',now()
  );
end $$;

revoke all on function public.report_operational_summary(uuid,uuid,uuid[],date,date,text) from public,anon,authenticated;
grant execute on function public.report_operational_summary(uuid,uuid,uuid[],date,date,text) to service_role;
