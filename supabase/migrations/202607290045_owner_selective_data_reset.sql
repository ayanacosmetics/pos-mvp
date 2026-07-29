-- Owner-only selective operational reset. Identity, tenant, outlets, locations,
-- device settings, backups and audit history are deliberately preserved.

create or replace function public.reset_tenant_data_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_scopes text[]
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_scopes text[]:=array(select distinct upper(value) from unnest(coalesce(p_scopes,'{}')) value);
  v_all boolean;
  v_operational boolean;
  v_catalog boolean;
  v_customers boolean;
  v_suppliers boolean;
  v_promotions boolean;
  v_finance boolean;
  v_workforce boolean;
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and role='OWNER' and active=true
  ) then raise exception 'Hanya Owner aktif yang dapat mereset data'; end if;
  if cardinality(v_scopes)=0 or exists(select 1 from unnest(v_scopes) value where value not in
    ('ALL','TRANSACTIONS','CATALOG','CUSTOMERS','SUPPLIERS','PROMOTIONS','FINANCE','WORKFORCE'))
  then raise exception 'Pilihan reset tidak valid'; end if;

  v_all:='ALL'=any(v_scopes);
  v_catalog:=v_all or 'CATALOG'=any(v_scopes);
  v_customers:=v_all or 'CUSTOMERS'=any(v_scopes);
  v_suppliers:=v_all or 'SUPPLIERS'=any(v_scopes);
  v_promotions:=v_all or 'PROMOTIONS'=any(v_scopes) or v_customers;
  v_workforce:=v_all or 'WORKFORCE'=any(v_scopes);
  v_operational:=v_all or 'TRANSACTIONS'=any(v_scopes) or v_catalog or v_customers or v_suppliers;
  v_finance:=v_all or 'FINANCE'=any(v_scopes) or v_operational;

  if v_operational then
    update public.vouchers set source_sale_id=null where tenant_id=p_tenant_id;
    update public.outlet_expenses set shift_id=null where tenant_id=p_tenant_id;
    delete from public.customer_payment_allocations where tenant_id=p_tenant_id;
    delete from public.customer_payment_receipts where tenant_id=p_tenant_id;
    delete from public.customer_account_entries where tenant_id=p_tenant_id;
    delete from public.customer_refunds where tenant_id=p_tenant_id;
    delete from public.customer_return_items where tenant_id=p_tenant_id;
    delete from public.customer_returns where tenant_id=p_tenant_id;
    delete from public.supplier_payment_allocations where tenant_id=p_tenant_id;
    delete from public.supplier_payment_receipts where tenant_id=p_tenant_id;
    delete from public.supplier_payable_entries where tenant_id=p_tenant_id;
    delete from public.supplier_bills where tenant_id=p_tenant_id;
    delete from public.supplier_return_items where tenant_id=p_tenant_id;
    delete from public.supplier_returns where tenant_id=p_tenant_id;
    delete from public.promotion_redemptions where tenant_id=p_tenant_id;
    delete from public.voucher_redemptions where tenant_id=p_tenant_id;
    delete from public.customer_point_entries where tenant_id=p_tenant_id;
    delete from public.sale_stock_allocations where tenant_id=p_tenant_id;
    delete from public.sale_adjustment_authorizations where tenant_id=p_tenant_id;
    delete from public.payments where tenant_id=p_tenant_id;
    delete from public.sale_items where tenant_id=p_tenant_id;
    delete from public.parked_sales where tenant_id=p_tenant_id;
    delete from public.sales where tenant_id=p_tenant_id;
    delete from public.purchase_receipt_items where tenant_id=p_tenant_id;
    delete from public.purchase_receipts where tenant_id=p_tenant_id;
    delete from public.purchase_order_items where tenant_id=p_tenant_id;
    delete from public.purchase_orders where tenant_id=p_tenant_id;
    delete from public.transfer_request_batches where tenant_id=p_tenant_id;
    delete from public.transfer_request_items where tenant_id=p_tenant_id;
    delete from public.transfer_requests where tenant_id=p_tenant_id;
    delete from public.stock_transfer_items where tenant_id=p_tenant_id;
    delete from public.stock_transfers where tenant_id=p_tenant_id;
    delete from public.stock_count_items where tenant_id=p_tenant_id;
    delete from public.stock_counts where tenant_id=p_tenant_id;
    delete from public.stock_adjustments where tenant_id=p_tenant_id;
    delete from public.inventory_batch_movements where tenant_id=p_tenant_id;
    update public.inventory_batches set source_batch_id=null where tenant_id=p_tenant_id;
    delete from public.inventory_batches where tenant_id=p_tenant_id;
    delete from public.stock_ledger where tenant_id=p_tenant_id;
    delete from public.stock_balances where tenant_id=p_tenant_id;
    delete from public.shift_reconciliations where tenant_id=p_tenant_id;
    delete from public.cash_movements where tenant_id=p_tenant_id;
    delete from public.shifts where tenant_id=p_tenant_id;
    delete from public.sync_commands where tenant_id=p_tenant_id;
    delete from public.import_jobs where tenant_id=p_tenant_id;
  end if;

  if v_finance then
    delete from public.journal_lines where tenant_id=p_tenant_id;
    delete from public.journal_entries where tenant_id=p_tenant_id;
    delete from public.accounting_periods where tenant_id=p_tenant_id;
    delete from public.outlet_expenses where tenant_id=p_tenant_id;
  end if;

  if v_promotions then
    update public.sales set voucher_id=null where tenant_id=p_tenant_id;
    delete from public.voucher_redemptions where tenant_id=p_tenant_id;
    delete from public.vouchers where tenant_id=p_tenant_id;
    delete from public.receipt_voucher_campaigns where tenant_id=p_tenant_id;
    delete from public.promotion_redemptions where tenant_id=p_tenant_id;
    delete from public.promotion_outlets where tenant_id=p_tenant_id;
    delete from public.promotion_versions where tenant_id=p_tenant_id;
    delete from public.promotions where tenant_id=p_tenant_id;
    delete from public.customer_point_entries where tenant_id=p_tenant_id;
    delete from public.customer_tiers where tenant_id=p_tenant_id;
    delete from public.loyalty_settings where tenant_id=p_tenant_id;
  end if;

  if v_workforce then
    delete from public.approval_requests where tenant_id=p_tenant_id;
    delete from public.approval_policies where tenant_id=p_tenant_id;
    delete from public.attendance_records where tenant_id=p_tenant_id;
    delete from public.employee_schedules where tenant_id=p_tenant_id;
    delete from public.employee_targets where tenant_id=p_tenant_id;
  end if;

  if v_catalog then
    delete from public.outlet_price_overrides where tenant_id=p_tenant_id;
    delete from public.restock_policies where tenant_id=p_tenant_id;
    delete from public.product_import_sku_reservations where tenant_id=p_tenant_id;
    delete from public.product_units where tenant_id=p_tenant_id;
    delete from public.price_rules where tenant_id=p_tenant_id;
    delete from public.products where tenant_id=p_tenant_id;
  end if;

  if v_customers then
    update public.vouchers set issued_customer_id=null where tenant_id=p_tenant_id;
    delete from public.customers where tenant_id=p_tenant_id;
  end if;

  if v_suppliers then
    delete from public.restock_policies where tenant_id=p_tenant_id;
    delete from public.suppliers where tenant_id=p_tenant_id;
  end if;

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,details_json)
  values(p_tenant_id,p_actor_id,'TENANT_DATA_RESET','tenant',
    jsonb_build_object('requestedScopes',p_scopes,'effective',jsonb_build_object(
      'operational',v_operational,'catalog',v_catalog,'customers',v_customers,
      'suppliers',v_suppliers,'promotions',v_promotions,'finance',v_finance,'workforce',v_workforce)));

  return jsonb_build_object('reset',true,'requestedScopes',p_scopes,'effectiveScopes',
    array_remove(array[
      case when v_operational then 'TRANSACTIONS' end,case when v_catalog then 'CATALOG' end,
      case when v_customers then 'CUSTOMERS' end,case when v_suppliers then 'SUPPLIERS' end,
      case when v_promotions then 'PROMOTIONS' end,case when v_finance then 'FINANCE' end,
      case when v_workforce then 'WORKFORCE' end
    ],null));
end;
$$;

revoke all on function public.reset_tenant_data_v1(uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.reset_tenant_data_v1(uuid,uuid,text[]) to service_role;
