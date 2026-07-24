-- Kasir Nusa v1.17 - pemeriksaan kesehatan data operasional

create or replace function public.operational_health_check(
  p_tenant_id uuid,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_role text;v_negative_stock integer;v_stock_mismatch integer;v_batch_negative integer;
  v_payment_mismatch integer;v_customer_mismatch integer;v_supplier_mismatch integer;
  v_old_shifts integer;v_sync_review integer;v_sync_failed integer;v_expired_approvals integer;
  v_status text;
begin
  select role into v_role from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true;
  if v_role<>'OWNER' then raise exception 'Hanya Owner yang dapat menjalankan pemeriksaan kesehatan sistem';end if;

  select count(*) into v_negative_stock from public.stock_balances where tenant_id=p_tenant_id and quantity<0;
  select count(*) into v_batch_negative from public.inventory_batches where tenant_id=p_tenant_id and available_qty<0;
  select count(*) into v_stock_mismatch from public.stock_balances b
  where b.tenant_id=p_tenant_id and exists(
    select 1 from lateral(select balance_after from public.stock_ledger l
      where l.tenant_id=b.tenant_id and l.location_id=b.location_id and l.product_id=b.product_id
      order by l.occurred_at desc,l.id desc limit 1) latest
    where abs(latest.balance_after-b.quantity)>0.000001
  );
  select count(*) into v_payment_mismatch from public.sales s
  where s.tenant_id=p_tenant_id and s.status='COMPLETED' and abs(s.grand_total-s.credit_amount-coalesce((
    select sum(p.amount) from public.payments p where p.sale_id=s.id
  ),0))>0.01;
  select case when abs(
    coalesce((select sum(e.amount) from public.customer_account_entries e where e.tenant_id=p_tenant_id),0)
    -coalesce((select sum(greatest(s.credit_amount-s.paid_credit_amount-s.returned_credit_amount,0))
      from public.sales s where s.tenant_id=p_tenant_id),0)
  )>0.01 then 1 else 0 end into v_customer_mismatch;
  select case when abs(
    coalesce((select sum(greatest(b.original_amount-b.return_credit_amount-b.paid_amount,0))
      from public.supplier_bills b where b.tenant_id=p_tenant_id),0)
    -coalesce((select sum(e.amount) from public.supplier_payable_entries e where e.tenant_id=p_tenant_id),0)
  )>0.01 then 1 else 0 end into v_supplier_mismatch;
  select count(*) into v_old_shifts from public.shifts where tenant_id=p_tenant_id and status='OPEN' and opened_at<now()-interval '24 hours';
  select count(*) into v_sync_review from public.sync_commands where tenant_id=p_tenant_id and status='NEEDS_REVIEW';
  select count(*) into v_sync_failed from public.sync_commands where tenant_id=p_tenant_id and status='FAILED';
  select count(*) into v_expired_approvals from public.sale_adjustment_authorizations where tenant_id=p_tenant_id and status='APPROVED' and expires_at<=now();
  v_status:=case when v_negative_stock+v_batch_negative+v_stock_mismatch+v_payment_mismatch+v_customer_mismatch+v_supplier_mismatch>0 then 'CRITICAL'
    when v_old_shifts+v_sync_review+v_sync_failed>0 then 'WARNING' else 'HEALTHY' end;
  return jsonb_build_object('status',v_status,'checkedAt',now(),'checks',jsonb_build_array(
    jsonb_build_object('code','NEGATIVE_STOCK','label','Stok negatif','count',v_negative_stock,'severity','CRITICAL'),
    jsonb_build_object('code','STOCK_LEDGER_MISMATCH','label','Saldo stok berbeda dari jurnal terakhir','count',v_stock_mismatch,'severity','CRITICAL'),
    jsonb_build_object('code','NEGATIVE_BATCH','label','Saldo batch negatif','count',v_batch_negative,'severity','CRITICAL'),
    jsonb_build_object('code','PAYMENT_MISMATCH','label','Pembayaran tidak sama dengan total struk','count',v_payment_mismatch,'severity','CRITICAL'),
    jsonb_build_object('code','CUSTOMER_BALANCE_MISMATCH','label','Piutang berbeda dari faktur terbuka','count',v_customer_mismatch,'severity','CRITICAL'),
    jsonb_build_object('code','SUPPLIER_BALANCE_MISMATCH','label','Hutang berbeda dari faktur terbuka','count',v_supplier_mismatch,'severity','CRITICAL'),
    jsonb_build_object('code','OLD_OPEN_SHIFT','label','Shift terbuka lebih dari 24 jam','count',v_old_shifts,'severity','WARNING'),
    jsonb_build_object('code','SYNC_REVIEW','label','Sinkronisasi menunggu keputusan','count',v_sync_review,'severity','WARNING'),
    jsonb_build_object('code','SYNC_FAILED','label','Sinkronisasi gagal','count',v_sync_failed,'severity','WARNING'),
    jsonb_build_object('code','EXPIRED_APPROVAL','label','Izin diskon kedaluwarsa menunggu pembersihan','count',v_expired_approvals,'severity','INFO')
  ));
end $$;
revoke all on function public.operational_health_check(uuid,uuid) from public,anon,authenticated;
grant execute on function public.operational_health_check(uuid,uuid) to service_role;
