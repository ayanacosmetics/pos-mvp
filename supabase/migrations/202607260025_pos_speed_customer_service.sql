-- Kasir Nusa POS v1.21 - cashier speed, receipt history, notes, and audited void
alter table public.sales add column if not exists notes text;
alter table public.sales add column if not exists void_reason text;
alter table public.sales add column if not exists voided_at timestamptz;
alter table public.sales add column if not exists voided_by uuid references public.profiles(user_id);
alter table public.sales add column if not exists void_approved_by uuid references public.profiles(user_id);
alter table public.parked_sales add column if not exists sale_notes text;

create index if not exists sales_pos_recent_idx
  on public.sales(tenant_id,outlet_id,occurred_at desc);

create or replace function public.complete_sale_v6(
  p_tenant_id uuid,p_actor_id uuid,p_idempotency_key text,p_outlet_id uuid,
  p_shift_id uuid,p_customer_id uuid,p_customer_group_id text,p_payments jsonb,p_quote jsonb,
  p_authorization_id uuid,p_basket_fingerprint text,p_notes text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;v_sale_id uuid;v_note text:=nullif(left(trim(coalesce(p_notes,'')),500),'');v_saved_note text;
begin
  v_result:=public.complete_sale_v5(
    p_tenant_id,p_actor_id,p_idempotency_key,p_outlet_id,p_shift_id,p_customer_id,
    p_customer_group_id,p_payments,p_quote,p_authorization_id,p_basket_fingerprint
  );
  v_sale_id:=(v_result->>'id')::uuid;
  if coalesce((v_result->>'duplicate')::boolean,false)=false then
    update public.sales set notes=v_note where id=v_sale_id and tenant_id=p_tenant_id returning notes into v_saved_note;
    if v_note is not null then
      insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
      values(p_tenant_id,p_actor_id,'SALE_NOTE_RECORDED','sale',v_sale_id,jsonb_build_object('length',length(v_note)));
    end if;
  else
    select notes into v_saved_note from public.sales where id=v_sale_id and tenant_id=p_tenant_id;
  end if;
  return v_result||jsonb_build_object('notes',v_saved_note);
end $$;

create or replace function public.void_sale_v1(
  p_tenant_id uuid,p_actor_id uuid,p_approved_by uuid,p_sale_id uuid,
  p_outlet_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales%rowtype;v_approver public.profiles%rowtype;v_location uuid;
  v_item public.sale_items%rowtype;v_balance public.stock_balances%rowtype;
  v_reason text:=nullif(left(trim(coalesce(p_reason,'')),240),'');v_index integer:=0;
begin
  if v_reason is null or length(v_reason)<5 then raise exception 'Alasan void minimal 5 karakter'; end if;
  if not exists(
    select 1 from public.profiles where tenant_id=p_tenant_id and user_id=p_actor_id
      and active=true and role in ('OWNER','ADMIN','CASHIER')
  ) then raise exception 'Akun tidak dapat membatalkan transaksi'; end if;
  select * into v_approver from public.profiles
    where tenant_id=p_tenant_id and user_id=p_approved_by and active=true
      and role in ('OWNER','ADMIN');
  if not found then raise exception 'Persetujuan Owner/Admin tidak valid'; end if;
  select * into v_sale from public.sales
    where id=p_sale_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id for update;
  if not found then raise exception 'Transaksi tidak ditemukan pada outlet aktif'; end if;
  if v_sale.status='VOIDED' then
    return jsonb_build_object('id',v_sale.id,'receiptNo',v_sale.receipt_no,'status','VOIDED','duplicate',true);
  end if;
  if v_sale.status<>'COMPLETED' then raise exception 'Hanya transaksi selesai yang dapat dibatalkan'; end if;
  if not exists(select 1 from public.shifts where id=v_sale.shift_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and status='OPEN')
    then raise exception 'Void hanya dapat dilakukan sebelum shift transaksi ditutup'; end if;
  if coalesce(v_sale.credit_amount,0)>0 then
    raise exception 'Transaksi piutang tidak dapat di-void; gunakan retur agar jurnal pelanggan tetap benar';
  end if;
  if exists(select 1 from public.customer_returns where tenant_id=p_tenant_id and sale_id=v_sale.id and status='COMPLETED')
    then raise exception 'Transaksi yang sudah diretur tidak dapat di-void'; end if;
  select id into v_location from public.stock_locations
    where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' and active=true
    order by id limit 1;
  if v_location is null then raise exception 'Lokasi stok toko aktif tidak ditemukan'; end if;
  for v_item in select * from public.sale_items where tenant_id=p_tenant_id and sale_id=v_sale.id order by id loop
    v_index:=v_index+1;
    select * into v_balance from public.stock_balances
      where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id for update;
    if not found then
      insert into public.stock_balances(tenant_id,location_id,product_id,quantity,avg_cost,version)
      values(p_tenant_id,v_location,v_item.product_id,v_item.base_qty,
        case when v_item.base_qty>0 then v_item.cost_total/v_item.base_qty else 0 end,1)
      returning * into v_balance;
    else
      update public.stock_balances set
        avg_cost=case when quantity+v_item.base_qty>0
          then ((quantity*avg_cost)+v_item.cost_total)/(quantity+v_item.base_qty)
          else avg_cost end,
        quantity=quantity+v_item.base_qty,version=version+1,updated_at=now()
        where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id;
    end if;
    select * into v_balance from public.stock_balances
      where tenant_id=p_tenant_id and location_id=v_location and product_id=v_item.product_id;
    insert into public.stock_ledger(
      tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,
      reference_id,note,actor_id,idempotency_key
    ) values(
      p_tenant_id,v_location,v_item.product_id,v_item.base_qty,v_balance.quantity,
      case when v_item.base_qty>0 then v_item.cost_total/v_item.base_qty else v_balance.avg_cost end,
      'SALE_VOID',v_sale.id,v_reason,p_actor_id,'VOID:'||v_sale.id::text||':'||v_index
    );
  end loop;
  update public.sales set status='VOIDED',void_reason=v_reason,voided_at=now(),
    voided_by=p_actor_id,void_approved_by=p_approved_by where id=v_sale.id;
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
  values(p_tenant_id,p_actor_id,'SALE_VOIDED','sale',v_sale.id,jsonb_build_object(
    'receiptNo',v_sale.receipt_no,'reason',v_reason,'approvedBy',p_approved_by,
    'grandTotal',v_sale.grand_total,'restoredItemCount',v_index
  ));
  return jsonb_build_object('id',v_sale.id,'receiptNo',v_sale.receipt_no,'status','VOIDED',
    'reason',v_reason,'approvedBy',v_approver.display_name,'duplicate',false);
end $$;

revoke all on function public.complete_sale_v6(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text,text) from public,anon,authenticated;
revoke all on function public.void_sale_v1(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.complete_sale_v6(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,jsonb,uuid,text,text) to service_role;
grant execute on function public.void_sale_v1(uuid,uuid,uuid,uuid,uuid,text) to service_role;
