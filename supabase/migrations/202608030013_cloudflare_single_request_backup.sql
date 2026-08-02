-- Export seluruh snapshot tenant melalui satu RPC agar proses backup/reset tidak
-- melampaui batas subrequest Cloudflare Workers Free.
create or replace function public.export_tenant_backup_v1(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text;
  v_relation regclass;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
  v_optional constant text[] := array[
    'product_families','product_family_barcodes','product_variant_options'
  ];
begin
  if p_tenant_id is null then
    raise exception 'Tenant wajib diisi';
  end if;

  foreach v_table in array array[
    'tenants','profiles','outlets','stock_locations','user_outlets',
    'customer_price_groups','customers','loyalty_settings','customer_tiers','customer_point_entries','vouchers','voucher_redemptions','receipt_voucher_campaigns','customer_account_entries','customer_payment_receipts','customer_payment_allocations','suppliers','supplier_bills','supplier_payable_entries','supplier_payment_receipts','supplier_payment_allocations','product_families','product_family_barcodes','products','product_variant_options','product_units','price_rules','promotions','promotion_versions','promotion_redemptions',
    'shifts','cash_movements','shift_reconciliations','sales','sale_items','payments','parked_sales','sale_adjustment_authorizations',
    'employee_schedules','attendance_records','employee_targets','approval_policies','approval_requests',
    'backup_exports','pilot_runs','pilot_check_results','production_incidents','recovery_drills',
    'expense_categories','outlet_expenses','chart_of_accounts','accounting_periods','journal_entries','journal_lines',
    'purchase_planning_settings','restock_policies','purchase_orders','purchase_order_items','purchase_receipts','purchase_receipt_items','supplier_returns','supplier_return_items',
    'stock_balances','stock_ledger','inventory_batches','inventory_batch_movements','sale_stock_allocations','stock_adjustments',
    'stock_transfers','stock_transfer_items','transfer_requests','transfer_request_items','transfer_request_batches','outlet_price_overrides','promotion_outlets','operational_notifications','stock_counts','stock_count_items',
    'customer_returns','customer_return_items','customer_refunds',
    'pos_devices','sync_commands','document_sequences','audit_logs','import_jobs'
  ] loop
    v_relation := to_regclass(format('public.%I',v_table));
    if v_relation is null then
      if v_table = any(v_optional) then
        v_tables := v_tables || jsonb_build_object(v_table,'[]'::jsonb);
        continue;
      end if;
      raise exception 'Tabel backup % belum tersedia',v_table;
    end if;

    if v_table = 'tenants' then
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(source_row)),''[]''::jsonb) from (select * from public.%I where id=$1) source_row',
        v_table
      ) into v_rows using p_tenant_id;
    else
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(source_row)),''[]''::jsonb) from (select * from public.%I where tenant_id=$1) source_row',
        v_table
      ) into v_rows using p_tenant_id;
    end if;
    v_tables := v_tables || jsonb_build_object(v_table,v_rows);
  end loop;

  return v_tables;
end;
$$;

revoke all on function public.export_tenant_backup_v1(uuid) from public, anon, authenticated;
grant execute on function public.export_tenant_backup_v1(uuid) to service_role;
