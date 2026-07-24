-- Kasir Nusa POS - registered devices and durable offline sale command processing

create table if not exists public.pos_devices (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  outlet_id uuid not null references public.outlets(id),
  name text not null,
  platform text,
  active boolean not null default true,
  created_by uuid not null references public.profiles(user_id),
  installed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.sync_commands add column if not exists actor_id uuid references public.profiles(user_id);
alter table public.sync_commands add column if not exists outlet_id uuid references public.outlets(id);
alter table public.sync_commands add column if not exists occurred_at timestamptz;
alter table public.sync_commands add column if not exists processed_at timestamptz;
alter table public.sync_commands add column if not exists result_json jsonb;
alter table public.sync_commands add column if not exists attempt_count int not null default 0;
alter table public.sync_commands add column if not exists updated_at timestamptz not null default now();

alter table public.pos_devices enable row level security;
drop policy if exists tenant_isolation on public.pos_devices;
create policy tenant_isolation on public.pos_devices for all to authenticated
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create index if not exists pos_devices_tenant_lookup on public.pos_devices(tenant_id,outlet_id,active);
create index if not exists sync_commands_status_lookup on public.sync_commands(tenant_id,device_id,status,received_at desc);

create or replace function public.complete_sale(
  p_tenant_id uuid, p_actor_id uuid, p_idempotency_key text, p_outlet_id uuid,
  p_shift_id uuid, p_customer_id uuid, p_customer_group_id text, p_payment_method text, p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sale uuid; v_existing record; v_location uuid; v_line jsonb; v_balance record; v_cost numeric:=0;
  v_line_cost numeric; v_seq bigint; v_receipt text; v_occurred_at timestamptz; v_index int:=0;
begin
  select * into v_existing from public.sales where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('id',v_existing.id,'receiptNo',v_existing.receipt_no,'status',v_existing.status,'duplicate',true); end if;
  v_occurred_at:=coalesce((p_quote->>'occurredAt')::timestamptz,now());
  if v_occurred_at>now()+interval '5 minutes' then raise exception 'Waktu transaksi berada di masa depan'; end if;
  if not exists(
    select 1 from public.shifts where id=p_shift_id and tenant_id=p_tenant_id and cashier_id=p_actor_id
      and v_occurred_at>=opened_at and v_occurred_at<=coalesce(closed_at,now()+interval '5 minutes')
  ) then raise exception 'Transaksi tidak berada dalam waktu shift kasir'; end if;
  select id into v_location from public.stock_locations where tenant_id=p_tenant_id and outlet_id=p_outlet_id and kind='STORE' limit 1;
  if v_location is null then raise exception 'Lokasi stok toko tidak ditemukan'; end if;
  insert into public.document_sequences(tenant_id,kind,next_value) values(p_tenant_id,'SALE',2)
  on conflict(tenant_id,kind) do update set next_value=public.document_sequences.next_value+1 returning next_value-1 into v_seq;
  v_receipt:='UTM-'||lpad(v_seq::text,6,'0');
  insert into public.sales(tenant_id,outlet_id,shift_id,customer_id,receipt_no,idempotency_key,cashier_id,customer_group_id,subtotal,discount_total,grand_total,cost_total,payment_method,occurred_at)
  values(p_tenant_id,p_outlet_id,p_shift_id,p_customer_id,v_receipt,p_idempotency_key,p_actor_id,p_customer_group_id,
    (p_quote->>'subtotal')::numeric,(p_quote->>'discountTotal')::numeric,(p_quote->>'grandTotal')::numeric,0,p_payment_method,v_occurred_at) returning id into v_sale;
  for v_line in select * from jsonb_array_elements(p_quote->'lines') loop
    v_index:=v_index+1;
    select * into v_balance from public.stock_balances where tenant_id=p_tenant_id and location_id=v_location and product_id=(v_line->>'productId')::uuid for update;
    if not found or v_balance.quantity < (v_line->>'baseQty')::numeric then raise exception 'Stok % tidak cukup',v_line->>'productName'; end if;
    v_line_cost:=v_balance.avg_cost*(v_line->>'baseQty')::numeric; v_cost:=v_cost+v_line_cost;
    update public.stock_balances set quantity=quantity-(v_line->>'baseQty')::numeric,version=version+1,updated_at=v_occurred_at
      where location_id=v_location and product_id=(v_line->>'productId')::uuid;
    insert into public.stock_ledger(tenant_id,location_id,product_id,delta,balance_after,unit_cost,event_type,reference_id,actor_id,idempotency_key,occurred_at)
    values(p_tenant_id,v_location,(v_line->>'productId')::uuid,-(v_line->>'baseQty')::numeric,v_balance.quantity-(v_line->>'baseQty')::numeric,
      v_balance.avg_cost,'SALE',v_sale,p_actor_id,p_idempotency_key||':stock:'||v_index,v_occurred_at);
    insert into public.sale_items(tenant_id,sale_id,product_id,product_name,base_qty,gross,discount,total,cost_total,pricing_snapshot,promotion_snapshot)
    values(p_tenant_id,v_sale,(v_line->>'productId')::uuid,v_line->>'productName',(v_line->>'baseQty')::numeric,(v_line->>'gross')::numeric,
      (v_line->>'discount')::numeric,(v_line->>'total')::numeric,v_line_cost,jsonb_build_object('priceRuleId',v_line->>'priceRuleId'),coalesce(v_line->'promotions','[]'));
  end loop;
  update public.sales set cost_total=v_cost where id=v_sale;
  insert into public.payments(tenant_id,sale_id,method,amount,created_at) values(p_tenant_id,v_sale,p_payment_method,(p_quote->>'grandTotal')::numeric,v_occurred_at);
  insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json,occurred_at)
  values(p_tenant_id,p_actor_id,'SALE_COMPLETED','sale',v_sale,jsonb_build_object('receiptNo',v_receipt,'grandTotal',p_quote->>'grandTotal','offline',p_quote?'occurredAt'),v_occurred_at);
  return jsonb_build_object('id',v_sale,'receiptNo',v_receipt,'status','COMPLETED','duplicate',false,'occurredAt',v_occurred_at);
end $$;

create or replace function public.resolve_sync_sale(
  p_tenant_id uuid, p_actor_id uuid, p_command_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_command public.sync_commands%rowtype; v_payload jsonb; v_quote jsonb; v_result jsonb; v_error text;
begin
  select * into v_command from public.sync_commands where id=p_command_id and tenant_id=p_tenant_id for update;
  if not found then raise exception 'Perintah sinkronisasi tidak ditemukan'; end if;
  if v_command.status in ('APPLIED','REJECTED') then return jsonb_build_object('id',v_command.id,'status',v_command.status,'result',v_command.result_json,'duplicate',true); end if;
  if v_command.status<>'NEEDS_REVIEW' then raise exception 'Perintah ini tidak sedang menunggu tinjauan'; end if;
  if upper(p_action)='REJECT' then
    v_result:=coalesce(v_command.result_json,'{}')||jsonb_build_object('decision','REJECTED','decidedBy',p_actor_id,'decidedAt',now());
    update public.sync_commands set status='REJECTED',result_json=v_result,processed_at=now(),updated_at=now() where id=v_command.id;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OFFLINE_SALE_REJECTED','sync_command',v_command.id,jsonb_build_object('idempotencyKey',v_command.idempotency_key));
    return jsonb_build_object('id',v_command.id,'status','REJECTED','result',v_result,'duplicate',false);
  end if;
  if upper(p_action)<>'APPROVE' then raise exception 'Keputusan sinkronisasi tidak valid'; end if;
  v_payload:=v_command.payload-'_serverQuote'; v_quote:=v_command.payload->'_serverQuote';
  if v_quote is null then raise exception 'Snapshot harga server tidak tersedia'; end if;
  begin
    v_result:=public.complete_sale(
      p_tenant_id,v_command.actor_id,v_command.idempotency_key,v_command.outlet_id,(v_payload->>'shiftId')::uuid,
      nullif(v_payload->>'customerId','')::uuid,coalesce(v_payload->>'customerGroupId','retail'),
      coalesce(v_payload->>'paymentMethod','Tunai'),v_quote||jsonb_build_object('occurredAt',v_command.occurred_at)
    );
    update public.sync_commands set status='APPLIED',payload=v_payload,result_json=v_result,processed_at=now(),updated_at=now() where id=v_command.id;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OFFLINE_SALE_APPROVED','sync_command',v_command.id,jsonb_build_object('idempotencyKey',v_command.idempotency_key,'saleId',v_result->>'id'));
    return jsonb_build_object('id',v_command.id,'status','APPLIED','result',v_result,'duplicate',false);
  exception when others then
    v_error:=sqlerrm;
    update public.sync_commands set status='FAILED',error_json=jsonb_build_object('message',v_error),processed_at=now(),updated_at=now() where id=v_command.id;
    return jsonb_build_object('id',v_command.id,'status','FAILED','error',v_error,'duplicate',false);
  end;
end $$;

create or replace function public.process_sync_sale(
  p_tenant_id uuid, p_actor_id uuid, p_device_id uuid, p_outlet_id uuid, p_device_name text,
  p_platform text, p_idempotency_key text, p_occurred_at timestamptz, p_payload jsonb,
  p_expected_total numeric, p_quote jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_command public.sync_commands%rowtype; v_result jsonb; v_error text;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Kunci transaksi sinkronisasi wajib diisi'; end if;
  if not exists(select 1 from public.outlets where id=p_outlet_id and tenant_id=p_tenant_id and active=true) then raise exception 'Outlet perangkat tidak valid'; end if;
  insert into public.pos_devices(id,tenant_id,outlet_id,name,platform,created_by)
  values(p_device_id,p_tenant_id,p_outlet_id,coalesce(nullif(trim(p_device_name),''),'Perangkat POS'),p_platform,p_actor_id)
  on conflict(id) do update set last_seen_at=now(),name=excluded.name,platform=excluded.platform
    where public.pos_devices.tenant_id=excluded.tenant_id and public.pos_devices.outlet_id=excluded.outlet_id;
  if not exists(select 1 from public.pos_devices where id=p_device_id and tenant_id=p_tenant_id and outlet_id=p_outlet_id and active=true) then raise exception 'Perangkat POS tidak aktif atau tidak sesuai outlet'; end if;

  insert into public.sync_commands(tenant_id,device_id,idempotency_key,command_type,payload,status,actor_id,outlet_id,occurred_at)
  values(p_tenant_id,p_device_id,p_idempotency_key,'SALE',p_payload,'RECEIVED',p_actor_id,p_outlet_id,p_occurred_at)
  on conflict(tenant_id,device_id,idempotency_key) do nothing;
  select * into v_command from public.sync_commands where tenant_id=p_tenant_id and device_id=p_device_id and idempotency_key=p_idempotency_key for update;
  if v_command.status in ('APPLIED','NEEDS_REVIEW','REJECTED') then
    return jsonb_build_object('key',p_idempotency_key,'status',v_command.status,'result',v_command.result_json,'duplicate',true);
  end if;
  update public.sync_commands set status='PROCESSING',attempt_count=attempt_count+1,updated_at=now(),error_json=null where id=v_command.id;
  if abs(coalesce(p_expected_total,0)-coalesce((p_quote->>'grandTotal')::numeric,0))>0.01 then
    v_result:=jsonb_build_object('expectedTotal',p_expected_total,'serverTotal',(p_quote->>'grandTotal')::numeric,'reason','Harga atau promo berubah saat perangkat offline');
    update public.sync_commands set status='NEEDS_REVIEW',payload=p_payload||jsonb_build_object('_serverQuote',p_quote),result_json=v_result,processed_at=now(),updated_at=now() where id=v_command.id;
    return jsonb_build_object('key',p_idempotency_key,'status','NEEDS_REVIEW','result',v_result,'duplicate',false);
  end if;
  begin
    v_result:=public.complete_sale(
      p_tenant_id,p_actor_id,p_idempotency_key,p_outlet_id,(p_payload->>'shiftId')::uuid,
      nullif(p_payload->>'customerId','')::uuid,coalesce(p_payload->>'customerGroupId','retail'),
      coalesce(p_payload->>'paymentMethod','Tunai'),p_quote||jsonb_build_object('occurredAt',p_occurred_at)
    );
    update public.sync_commands set status='APPLIED',result_json=v_result,processed_at=now(),updated_at=now() where id=v_command.id;
    return jsonb_build_object('key',p_idempotency_key,'status','APPLIED','result',v_result,'duplicate',false);
  exception when others then
    v_error:=sqlerrm;
    update public.sync_commands set status='FAILED',error_json=jsonb_build_object('message',v_error),processed_at=now(),updated_at=now() where id=v_command.id;
    return jsonb_build_object('key',p_idempotency_key,'status','FAILED','error',v_error,'duplicate',false);
  end;
end $$;

revoke all on function public.process_sync_sale(uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb,numeric,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_sync_sale(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.process_sync_sale(uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb,numeric,jsonb) to service_role;
grant execute on function public.resolve_sync_sale(uuid,uuid,uuid,text) to service_role;
grant select,insert,update,delete on public.pos_devices to service_role;
grant select on public.pos_devices to authenticated;
