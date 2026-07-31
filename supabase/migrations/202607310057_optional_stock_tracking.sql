-- Products may be sold without maintaining an inventory balance.
begin;

alter table public.products add column if not exists track_stock boolean not null default true;

create or replace function public.save_product_v6(
  p_tenant_id uuid,p_actor_id uuid,p_product jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;v_product_id uuid;v_track boolean;
begin
  v_result:=public.save_product_v5(p_tenant_id,p_actor_id,p_product);
  v_product_id:=(v_result->>'id')::uuid;v_track:=coalesce((p_product->>'trackStock')::boolean,true);
  update public.products set track_stock=v_track,
    minimum_stock=case when v_track then minimum_stock else 0 end,
    track_expiry=case when v_track then track_expiry else false end,updated_at=now()
    where tenant_id=p_tenant_id and id=v_product_id;
  perform public.refresh_safe_customer_prices_v1(p_tenant_id,v_product_id);
  return v_result||jsonb_build_object('trackStock',v_track);
end $$;

create or replace function public.apply_import_product_settings_v1(p_tenant_id uuid,p_actor_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN')) then raise exception 'Akses ditolak';end if;
  update public.products p set
    track_stock=coalesce((r.value->>'trackStock')::boolean,true),
    minimum_stock=case when coalesce((r.value->>'trackStock')::boolean,true) then coalesce((r.value->>'minimumStock')::numeric,0) else 0 end,
    track_expiry=case when coalesce((r.value->>'trackStock')::boolean,true) then coalesce((r.value->>'trackExpiry')::boolean,false) else false end,
    updated_at=now()
  from jsonb_array_elements(p_rows) r where p.tenant_id=p_tenant_id and p.sku=upper(trim(r.value->>'sku'));
  get diagnostics v_count=row_count;return v_count;
end $$;

-- This remains the base posting engine called by complete_sale_v4..v7.
create or replace function public.complete_sale_v3(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_shift_id uuid,p_customer_id uuid,p_customer_group_id text,p_payments jsonb,p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid;v_existing public.sales%rowtype;v_location uuid;v_line jsonb;v_payment jsonb;
  v_balance public.stock_balances%rowtype;v_outlet public.outlets%rowtype;v_product public.products%rowtype;v_cost numeric:=0;
  v_line_cost numeric;v_seq bigint;v_receipt text;v_due numeric:=(p_quote->>'grandTotal')::numeric;
  v_paid numeric:=0;v_tendered numeric;v_amount numeric;v_change numeric:=0;v_method text;
  v_payment_count integer:=0;v_payment_label text;v_line_index integer:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true,'change',0);end if;
  select * into v_outlet from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true;
  if not found then raise exception 'Outlet transaksi tidak aktif';end if;
  if not exists(select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and cashier_id=p_actor_id and status='OPEN') then raise exception 'Shift kasir belum dibuka';end if;
  if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'Pembayaran wajib diisi';end if;
  if jsonb_array_length(p_payments)>4 then raise exception 'Maksimal empat metode pembayaran';end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method'));v_amount:=coalesce((v_payment->>'amount')::numeric,0);
    if v_method not in('CASH','QRIS','TRANSFER','EDC','CREDIT') then raise exception 'Metode pembayaran % tidak valid',v_method;end if;
    if v_amount<=0 then raise exception 'Jumlah pembayaran harus lebih dari nol';end if;
    v_paid:=v_paid+v_amount;v_payment_count:=v_payment_count+1;
    if v_method='CASH' then v_tendered:=coalesce((v_payment->>'tendered')::numeric,v_amount);if v_tendered<v_amount then raise exception 'Uang tunai diterima kurang dari bagian tunai';end if;v_change:=v_change+(v_tendered-v_amount);end if;
  end loop;
  if abs(v_paid-v_due)>0.01 then raise exception 'Total pembayaran % tidak sama dengan total transaksi %',v_paid,v_due;end if;
  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' and active=true order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko aktif tidak ditemukan';end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE:'||p_outlet_id::text,2)
    on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:=v_outlet.receipt_prefix||'-'||lpad(v_seq::text,6,'0');
  if v_payment_count>1 then v_payment_label:='Gabungan';else v_payment_label:=case upper(p_payments->0->>'method') when 'CASH' then 'Tunai' when 'QRIS' then 'QRIS' when 'TRANSFER' then 'Transfer' when 'CREDIT' then 'Piutang' else 'EDC' end;end if;
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,(p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,v_due,0,v_payment_label) returning id into v_sale;
  for v_line in select value from jsonb_array_elements(p_quote->'lines') loop
    v_line_index:=v_line_index+1;v_line_cost:=0;
    select * into v_product from public.products where tenant_id=p_tenant_id and id=(v_line->>'productId')::uuid and active=true;
    if not found then raise exception 'Produk % tidak ditemukan atau tidak aktif',v_line->>'productName';end if;
    if v_product.track_stock then
      select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=v_product.id for update;
      if not found or v_balance.quantity<(v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName';end if;
      v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric;v_cost:=v_cost+v_line_cost;
      update public.stock_balances set quantity=quantity-(v_line->>'baseQty')::numeric,version=version+1,updated_at=now() where location_id=v_location and product_id=v_product.id;
      insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key)
      values(p_tenant_id,v_location,v_product.id,-(v_line->>'baseQty')::numeric,v_balance.quantity-(v_line->>'baseQty')::numeric,v_balance.avg_cost,'SALE',v_sale,p_actor_id,p_idempotency_key||':stock:'||v_line_index);
    end if;
    insert into public.sale_items(tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,pricing_snapshot,promotion_snapshot)
    values(p_tenant_id,v_sale,v_product.id,v_line->>'productName',(v_line->>'baseQty')::numeric,(v_line->>'gross')::numeric,(v_line->>'discount')::numeric,(v_line->>'total')::numeric,v_line_cost,
      jsonb_build_object('priceRuleId',v_line->>'priceRuleId','unitName',v_line->>'unitName','qty',v_line->>'qty','trackStock',v_product.track_stock),coalesce(v_line->'promotions','[]'));
  end loop;
  update public.sales set cost_total=v_cost where id=v_sale;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method:=upper(trim(v_payment->>'method'));v_amount:=(v_payment->>'amount')::numeric;v_tendered:=case when v_method='CASH' then coalesce((v_payment->>'tendered')::numeric,v_amount) else null end;
    insert into public.payments(tenant_id,sale_id,method,amount,reference,tendered_amount,change_amount) values(p_tenant_id,v_sale,v_method,v_amount,nullif(trim(v_payment->>'reference'),''),v_tendered,case when v_method='CASH' then v_tendered-v_amount else 0 end);
  end loop;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json) values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,jsonb_build_object('receiptNo',v_receipt,'grandTotal',v_due,'paymentCount',v_payment_count,'change',v_change,'outletPrefix',v_outlet.receipt_prefix));
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false,'change',v_change,'payments',p_payments);
end $$;

create or replace function public.void_sale_v1(
  p_tenant_id uuid,p_actor_id uuid,p_approved_by uuid,p_sale_id uuid,
  p_outlet_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales%rowtype;v_approver public.profiles%rowtype;v_location uuid;
  v_item public.sale_items%rowtype;v_balance public.stock_balances%rowtype;
  v_reason text:=nullif(left(trim(coalesce(p_reason,'')),240),'');v_index integer:=0;v_restored integer:=0;
begin
  if v_reason is null or length(v_reason)<5 then raise exception 'Alasan void minimal 5 karakter';end if;
  if not exists(select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id and active=true and role in('OWNER','ADMIN','CASHIER')) then raise exception 'Akun tidak dapat membatalkan transaksi';end if;
  select * into v_approver from public.profiles where tenant_id=p_tenant_id and user_id=p_approved_by and active=true and role in('OWNER','ADMIN');
  if not found then raise exception 'Persetujuan Owner/Admin tidak valid';end if;
  select * into v_sale from public.sales where id=p_sale_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id for update;
  if not found then raise exception 'Transaksi tidak ditemukan pada outlet aktif';end if;
  if v_sale.status='VOIDED' then return jsonb_build_object('id',v_sale.id,'receiptNo',v_sale.receipt_no,'status','VOIDED','duplicate',true);end if;
  if v_sale.status<>'COMPLETED' then raise exception 'Hanya transaksi selesai yang dapat dibatalkan';end if;
  if not exists(select 1 from public.shifts where id=v_sale.shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and status='OPEN') then raise exception 'Void hanya dapat dilakukan sebelum shift transaksi ditutup';end if;
  if coalesce(v_sale.credit_amount,0)>0 then raise exception 'Transaksi piutang tidak dapat di-void; gunakan retur agar jurnal pelanggan tetap benar';end if;
  if exists(select 1 from public.customer_returns where tenant_id=p_tenant_id and sale_id=v_sale.id and status='COMPLETED') then raise exception 'Transaksi yang sudah diretur tidak dapat di-void';end if;
  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' and active=true order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko aktif tidak ditemukan';end if;
  for v_item in select * from public.sale_items where tenant_id=p_tenant_id and sale_id=v_sale.id order by id loop
    v_index:=v_index+1;
    if not exists(select 1 from public.products where tenant_id=p_tenant_id and id=v_item.product_id and track_stock=true) then continue;end if;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id for update;
    if not found then
      insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost,version)
      values(p_tenant_id,v_location,v_item.product_id,v_item.base_qty,case when v_item.base_qty>0 then v_item.cost_total/v_item.base_qty else 0 end,1) returning * into v_balance;
    else
      update public.stock_balances set avg_cost=case when quantity+v_item.base_qty>0 then ((quantity*avg_cost)+v_item.cost_total)/(quantity+v_item.base_qty) else avg_cost end,
        quantity=quantity+v_item.base_qty,version=version+1,updated_at=now()
      where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id;
    end if;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,note,actor_id,idempotency_key)
    values(p_tenant_id,v_location,v_item.product_id,v_item.base_qty,v_balance.quantity,case when v_item.base_qty>0 then v_item.cost_total/v_item.base_qty else v_balance.avg_cost end,'SALE_VOID',v_sale.id,v_reason,p_actor_id,'VOID:'||v_sale.id::text||':'||v_index);
    v_restored:=v_restored+1;
  end loop;
  update public.sales set status='VOIDED',void_reason=v_reason,voided_at=now(),voided_by=p_actor_id,void_approved_by=p_approved_by where id=v_sale.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_VOIDED','sale',v_sale.id,jsonb_build_object('receiptNo',v_sale.receipt_no,'reason',v_reason,'approvedBy',p_approved_by,'grandTotal',v_sale.grand_total,'restoredItemCount',v_restored));
  return jsonb_build_object('id',v_sale.id,'receiptNo',v_sale.receipt_no,'status','VOIDED','reason',v_reason,'approvedBy',v_approver.display_name,'duplicate',false);
end $$;

revoke all on function public.save_product_v6(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.apply_import_product_settings_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.complete_sale_v3(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.void_sale_v1(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_product_v6(uuid,uuid,jsonb) to service_role;
grant execute on function public.apply_import_product_settings_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.complete_sale_v3(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb) to service_role;
grant execute on function public.void_sale_v1(uuid,uuid,uuid,uuid,uuid,text) to service_role;

commit;
