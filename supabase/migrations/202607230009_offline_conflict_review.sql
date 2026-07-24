-- Kasir Nusa POS - safe owner decisions for offline price conflicts

alter table public.sync_commands add column if not exists decision_action text;
alter table public.sync_commands add column if not exists decision_by uuid references public.profiles(user_id);
alter table public.sync_commands add column if not exists decision_at timestamptz;

create index if not exists sync_commands_review_queue
  on public.sync_commands(tenant_id,status,received_at)
  where status='NEEDS_REVIEW';

create or replace function public.resolve_sync_sale(
  p_tenant_id uuid, p_actor_id uuid, p_command_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_command public.sync_commands%rowtype;
  v_payload jsonb;
  v_quote jsonb;
  v_result jsonb;
  v_error text;
  v_action text:=upper(trim(coalesce(p_action,'')));
  v_expected numeric;
  v_server numeric;
begin
  if not exists(
    select 1 from public.profiles
    where user_id=p_actor_id and tenant_id=p_tenant_id and active=true and role in ('OWNER','ADMIN')
  ) then raise exception 'Hanya Owner atau Admin aktif yang dapat memutuskan konflik'; end if;

  select * into v_command
  from public.sync_commands
  where id=p_command_id and tenant_id=p_tenant_id
  for update;
  if not found then raise exception 'Perintah sinkronisasi tidak ditemukan'; end if;
  if v_command.status in ('APPLIED','REJECTED') then
    return jsonb_build_object('id',v_command.id,'status',v_command.status,'result',v_command.result_json,'duplicate',true);
  end if;
  if v_command.status<>'NEEDS_REVIEW' then raise exception 'Perintah ini tidak sedang menunggu tinjauan'; end if;

  v_expected:=coalesce((v_command.result_json->>'expectedTotal')::numeric,0);
  v_server:=coalesce((v_command.result_json->>'serverTotal')::numeric,0);

  if v_action='REJECT' then
    v_result:=coalesce(v_command.result_json,'{}')||jsonb_build_object(
      'decision','REJECTED','decidedBy',p_actor_id,'decidedAt',now()
    );
    update public.sync_commands set
      status='REJECTED',result_json=v_result,error_json=null,processed_at=now(),updated_at=now(),
      decision_action='REJECTED',decision_by=p_actor_id,decision_at=now()
    where id=v_command.id;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OFFLINE_SALE_REJECTED','sync_command',v_command.id,
      jsonb_build_object('idempotencyKey',v_command.idempotency_key,'expectedTotal',v_expected,'serverTotal',v_server));
    return jsonb_build_object('id',v_command.id,'status','REJECTED','result',v_result,'duplicate',false);
  end if;

  v_payload:=v_command.payload-'_serverQuote';
  if v_action in ('APPROVE','APPLY_SERVER') then
    v_action:='APPLY_SERVER';
    v_quote:=v_command.payload->'_serverQuote';
    if v_quote is null then raise exception 'Snapshot harga server tidak tersedia'; end if;
  elsif v_action='HONOR_OFFLINE' then
    v_quote:=v_payload->'offlineQuote';
    if v_quote is null or jsonb_typeof(v_quote)<>'object' then
      raise exception 'Snapshot harga kasir tidak tersedia untuk transaksi lama ini';
    end if;
    if jsonb_typeof(v_quote->'lines')<>'array' or jsonb_typeof(v_payload->'lines')<>'array' then
      raise exception 'Snapshot transaksi offline tidak valid';
    end if;
    if jsonb_array_length(v_quote->'lines')<>jsonb_array_length(v_payload->'lines') then
      raise exception 'Barang pada snapshot harga tidak sama dengan keranjang offline';
    end if;
    if exists(
      with payload_lines as (
        select p->>'productId' product_id,p->>'unitId' unit_id,count(*) line_count,sum((p->>'qty')::numeric) qty
        from jsonb_array_elements(v_payload->'lines') p group by 1,2
      ), quote_lines as (
        select q->>'productId' product_id,q->>'unitId' unit_id,count(*) line_count,sum((q->>'qty')::numeric) qty
        from jsonb_array_elements(v_quote->'lines') q group by 1,2
      )
      select 1 from payload_lines p full join quote_lines q using(product_id,unit_id)
      where p.product_id is null or q.product_id is null or p.line_count<>q.line_count or abs(p.qty-q.qty)>=0.000001
    ) then raise exception 'Isi snapshot harga tidak sama dengan keranjang offline'; end if;
    if v_expected<0 or coalesce((v_quote->>'subtotal')::numeric,-1)<0
      or coalesce((v_quote->>'discountTotal')::numeric,-1)<0
      or coalesce((v_quote->>'grandTotal')::numeric,-1)<0
      or exists(
        select 1 from jsonb_array_elements(v_quote->'lines') line
        where coalesce((line->>'gross')::numeric,-1)<0 or coalesce((line->>'discount')::numeric,-1)<0
          or coalesce((line->>'total')::numeric,-1)<0
          or abs((line->>'gross')::numeric-(line->>'discount')::numeric-(line->>'total')::numeric)>0.01
      )
    then raise exception 'Nilai snapshot harga kasir tidak valid'; end if;
    if abs(coalesce((v_quote->>'grandTotal')::numeric,0)-v_expected)>0.01 then
      raise exception 'Total snapshot harga kasir tidak cocok dengan total offline';
    end if;
    if abs(
      coalesce((select sum((line->>'total')::numeric) from jsonb_array_elements(v_quote->'lines') line),0)
      -coalesce((v_quote->>'grandTotal')::numeric,0)
    )>0.01 then raise exception 'Rincian snapshot harga kasir tidak seimbang'; end if;
    if abs(
      coalesce((select sum((line->>'gross')::numeric) from jsonb_array_elements(v_quote->'lines') line),0)
      -coalesce((v_quote->>'subtotal')::numeric,0)
    )>0.01 or abs(
      coalesce((select sum((line->>'discount')::numeric) from jsonb_array_elements(v_quote->'lines') line),0)
      -coalesce((v_quote->>'discountTotal')::numeric,0)
    )>0.01 then raise exception 'Subtotal snapshot harga kasir tidak seimbang'; end if;
  else
    raise exception 'Keputusan sinkronisasi tidak valid';
  end if;

  begin
    v_result:=public.complete_sale(
      p_tenant_id,v_command.actor_id,v_command.idempotency_key,v_command.outlet_id,
      (v_payload->>'shiftId')::uuid,nullif(v_payload->>'customerId','')::uuid,
      coalesce(v_payload->>'customerGroupId','retail'),coalesce(v_payload->>'paymentMethod','Tunai'),
      v_quote||jsonb_build_object('occurredAt',v_command.occurred_at)
    )||jsonb_build_object(
      'decision',v_action,'expectedTotal',v_expected,'serverTotal',v_server,
      'decidedBy',p_actor_id,'decidedAt',now()
    );
    update public.sync_commands set
      status='APPLIED',payload=v_payload,result_json=v_result,error_json=null,processed_at=now(),updated_at=now(),
      decision_action=v_action,decision_by=p_actor_id,decision_at=now()
    where id=v_command.id;
    insert into public.audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'OFFLINE_SALE_'||v_action,'sync_command',v_command.id,
      jsonb_build_object('idempotencyKey',v_command.idempotency_key,'saleId',v_result->>'id',
        'expectedTotal',v_expected,'serverTotal',v_server));
    return jsonb_build_object('id',v_command.id,'status','APPLIED','result',v_result,'duplicate',false);
  exception when others then
    v_error:=sqlerrm;
    update public.sync_commands set
      status='NEEDS_REVIEW',error_json=jsonb_build_object('message',v_error),attempt_count=attempt_count+1,updated_at=now()
    where id=v_command.id;
    return jsonb_build_object('id',v_command.id,'status','NEEDS_REVIEW','error',v_error,'duplicate',false);
  end;
end $$;

revoke all on function public.resolve_sync_sale(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resolve_sync_sale(uuid,uuid,uuid,text) to service_role;
