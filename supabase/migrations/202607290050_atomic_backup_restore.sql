-- Owner-only atomic restore of operational data from a verified Kasir Nusa
-- backup. Identity, tenant, outlets, locations, devices, settings, backups,
-- and existing audit history remain managed by the live workspace.

create or replace function public.restore_tenant_backup_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_tables jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_table text;
  v_rows bigint:=0;
  v_tables jsonb:=coalesce(p_tables,'{}'::jsonb);
  v_order text[]:=array[
    'suppliers',
    'products','product_units','price_rules',
    'customer_tiers','customers','loyalty_settings',
    'promotions','promotion_versions','promotion_outlets','receipt_voucher_campaigns',
    'employee_schedules','attendance_records','employee_targets','approval_policies','approval_requests',
    'shifts','cash_movements','shift_reconciliations',
    'sales','vouchers','parked_sales','sale_adjustment_authorizations','sale_items','payments',
    'promotion_redemptions','voucher_redemptions','customer_point_entries',
    'customer_returns','customer_return_items','customer_refunds',
    'customer_account_entries','customer_payment_receipts','customer_payment_allocations',
    'purchase_orders','purchase_order_items','purchase_receipts','purchase_receipt_items',
    'inventory_batches','stock_balances','stock_ledger','inventory_batch_movements',
    'sale_stock_allocations','stock_adjustments',
    'supplier_bills','supplier_payable_entries','supplier_payment_receipts',
    'supplier_payment_allocations','supplier_returns','supplier_return_items',
    'stock_transfers','stock_transfer_items',
    'transfer_requests','transfer_request_items','transfer_request_batches',
    'stock_counts','stock_count_items','restock_policies','outlet_price_overrides',
    'accounting_periods','journal_entries','journal_lines','outlet_expenses',
    'sync_commands','import_jobs'
  ];
begin
  if not exists(
    select 1 from public.profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and role='OWNER' and active=true
  ) then raise exception 'Hanya Owner aktif yang dapat memulihkan backup'; end if;
  if jsonb_typeof(v_tables)<>'object' then raise exception 'Isi backup tidak valid'; end if;

  -- Prevent normal posting triggers from recalculating restored historical
  -- rows. The ALTER statements and all inserted data roll back together on
  -- any error.
  execute 'alter table public.customers disable trigger user';
  execute 'alter table public.sales disable trigger user';
  execute 'alter table public.sale_items disable trigger user';
  execute 'alter table public.purchase_receipts disable trigger user';
  execute 'alter table public.purchase_receipt_items disable trigger user';
  execute 'alter table public.supplier_returns disable trigger user';
  execute 'alter table public.stock_ledger disable trigger user';
  execute 'alter table public.stock_balances disable trigger user';

  perform public.reset_tenant_data_v1(p_tenant_id,p_actor_id,array['ALL']::text[]);

  -- Break the three circular/self references while their parent rows are
  -- restored, then reconnect them after every referenced row exists.
  v_tables:=jsonb_set(v_tables,'{sales}',coalesce((
    select jsonb_agg(value-'voucher_id') from jsonb_array_elements(coalesce(v_tables->'sales','[]'::jsonb))
  ),'[]'::jsonb),true);
  v_tables:=jsonb_set(v_tables,'{inventory_batches}',coalesce((
    select jsonb_agg(value-'source_batch_id') from jsonb_array_elements(coalesce(v_tables->'inventory_batches','[]'::jsonb))
  ),'[]'::jsonb),true);
  v_tables:=jsonb_set(v_tables,'{journal_entries}',coalesce((
    select jsonb_agg(value-'reversal_of') from jsonb_array_elements(coalesce(v_tables->'journal_entries','[]'::jsonb))
  ),'[]'::jsonb),true);

  foreach v_table in array v_order loop
    if jsonb_typeof(coalesce(v_tables->v_table,'[]'::jsonb))<>'array' then
      raise exception 'Isi tabel % pada backup tidak valid',v_table;
    end if;
    execute format(
      'insert into public.%1$I select row_data.* from jsonb_populate_recordset(null::public.%1$I,$1) row_data where row_data.tenant_id=$2',
      v_table
    ) using coalesce(v_tables->v_table,'[]'::jsonb),p_tenant_id;
    v_rows:=v_rows+jsonb_array_length(coalesce(v_tables->v_table,'[]'::jsonb));
  end loop;

  update public.sales sale set voucher_id=(item->>'voucher_id')::uuid
  from jsonb_array_elements(coalesce(p_tables->'sales','[]'::jsonb)) item
  where sale.id=(item->>'id')::uuid and sale.tenant_id=p_tenant_id
    and nullif(item->>'voucher_id','') is not null;

  update public.inventory_batches batch set source_batch_id=(item->>'source_batch_id')::uuid
  from jsonb_array_elements(coalesce(p_tables->'inventory_batches','[]'::jsonb)) item
  where batch.id=(item->>'id')::uuid and batch.tenant_id=p_tenant_id
    and nullif(item->>'source_batch_id','') is not null;

  update public.journal_entries entry set reversal_of=(item->>'reversal_of')::uuid
  from jsonb_array_elements(coalesce(p_tables->'journal_entries','[]'::jsonb)) item
  where entry.id=(item->>'id')::uuid and entry.tenant_id=p_tenant_id
    and nullif(item->>'reversal_of','') is not null;

  execute 'alter table public.customers enable trigger user';
  execute 'alter table public.sales enable trigger user';
  execute 'alter table public.sale_items enable trigger user';
  execute 'alter table public.purchase_receipts enable trigger user';
  execute 'alter table public.purchase_receipt_items enable trigger user';
  execute 'alter table public.supplier_returns enable trigger user';
  execute 'alter table public.stock_ledger enable trigger user';
  execute 'alter table public.stock_balances enable trigger user';

  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,details_json)
  values(p_tenant_id,p_actor_id,'TENANT_BACKUP_RESTORED','tenant',
    jsonb_build_object('restoredRows',v_rows,'schemaVersion',1));

  return jsonb_build_object('restored',true,'restoredRows',v_rows);
end;
$$;

revoke all on function public.restore_tenant_backup_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.restore_tenant_backup_v1(uuid,uuid,jsonb) to service_role;

-- Execute the complete restore inside a subtransaction and deliberately roll
-- it back. The API runs this before sending an OTP, so a broken or outdated
-- backup cannot consume the Owner's one-time code.
create or replace function public.dry_run_restore_tenant_backup_v1(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_tables jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_result jsonb;
begin
  begin
    v_result:=public.restore_tenant_backup_v1(p_tenant_id,p_actor_id,p_tables);
    raise exception using errcode='ZX001',message='__RESTORE_DRY_RUN_OK__';
  exception
    when sqlstate 'ZX001' then
      return jsonb_build_object(
        'valid',true,
        'restoredRows',coalesce((v_result->>'restoredRows')::bigint,0)
      );
    when others then
      return jsonb_build_object('valid',false,'error',sqlerrm,'sqlstate',sqlstate);
  end;
end;
$$;

revoke all on function public.dry_run_restore_tenant_backup_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dry_run_restore_tenant_backup_v1(uuid,uuid,jsonb) to service_role;
