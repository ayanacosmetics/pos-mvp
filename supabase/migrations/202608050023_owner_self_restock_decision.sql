-- Let the business Owner finish a restock they initiated personally.
-- Admin self-approval remains forbidden; every decision is still audited.
begin;

create or replace function public.decide_restock_approval_v1(
  p_tenant_id uuid,p_actor_id uuid,p_request_id uuid,p_decision text,
  p_approved_prices jsonb default '[]'::jsonb,p_note text default ''
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_request restock_approval_requests%rowtype;
  v_decision text:=upper(trim(p_decision));
  v_price jsonb;
  v_status text;
  v_actor_role text;
begin
  select role into v_actor_role from profiles
    where tenant_id=p_tenant_id and user_id=p_actor_id and active and role in('OWNER','ADMIN');
  if v_actor_role is null then raise exception 'Hanya Owner/Admin yang dapat memutuskan';end if;

  select * into v_request from restock_approval_requests
    where tenant_id=p_tenant_id and id=p_request_id for update;
  if not found then raise exception 'Permintaan tidak ditemukan';end if;
  if v_request.status<>'PENDING' then raise exception 'Permintaan tidak sedang menunggu keputusan';end if;
  if v_request.requester_id=p_actor_id and v_actor_role<>'OWNER' then
    raise exception 'Admin pemohon tidak dapat memutuskan permintaannya sendiri';
  end if;

  if v_decision='APPROVE' then
    if jsonb_typeof(p_approved_prices)<>'array' then raise exception 'Harga persetujuan tidak valid';end if;
    for v_price in select value from jsonb_array_elements(p_approved_prices) loop
      if coalesce((v_price->>'minBaseQty')::integer,0)<1 or coalesce((v_price->>'unitPriceBase')::numeric,0)<=0 then
        raise exception 'Harga jual harus lebih dari nol';
      end if;
    end loop;
    update restock_approval_requests set status='APPROVED',approver_id=p_actor_id,
      approved_prices_json=p_approved_prices,decision_note=nullif(trim(p_note),''),
      decided_at=now(),updated_at=now() where id=p_request_id;
    v_status:='APPROVED';
  elsif v_decision='REJECT' then
    update restock_approval_requests set status='REJECTED',approver_id=p_actor_id,
      decision_note=nullif(trim(p_note),''),decided_at=now(),updated_at=now() where id=p_request_id;
    v_status:='REJECTED';
  elsif v_decision='REVISE' then
    if nullif(trim(p_note),'') is null then raise exception 'Alasan revisi wajib diisi';end if;
    update restock_approval_requests set status='REVISION_REQUIRED',approver_id=p_actor_id,
      decision_note=trim(p_note),decided_at=now(),updated_at=now(),
      revision_history_json=revision_history_json||jsonb_build_array(jsonb_build_object(
        'action','REVISION_REQUESTED','actorId',p_actor_id,'note',trim(p_note),'at',now()))
      where id=p_request_id;
    v_status:='REVISION_REQUIRED';
  else
    raise exception 'Keputusan tidak valid';
  end if;

  insert into audit_logs(tenant_id,actor_id,action,entity_type,entity_id,details_json)
    values(p_tenant_id,p_actor_id,'RESTOCK_PRICE_APPROVAL_DECIDED','restock_approval',p_request_id,
      jsonb_build_object('decision',v_decision,'note',nullif(trim(p_note),''),
        'ownerSelfDecision',v_request.requester_id=p_actor_id));
  return jsonb_build_object('id',p_request_id,'status',v_status);
end $$;

revoke all on function public.decide_restock_approval_v1(uuid,uuid,uuid,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.decide_restock_approval_v1(uuid,uuid,uuid,text,jsonb,text)
  to service_role;

commit;
